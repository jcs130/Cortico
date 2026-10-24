import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { VRMLoaderPlugin, VRMUtils } from "@pixiv/three-vrm";
import { expressionWeights } from "./expression-weights.js";
import { AudioOutput } from "./audio.js";
import { VRMMotionLayer } from "./vrm-motion.js";
import { PerformanceCues } from "./performance-cues.js";
const $ = (s) => document.querySelector(s),
  obs = new URLSearchParams(location.search).has("obs"),
  sessionId = crypto.randomUUID();
if (obs) document.body.classList.add("obs");
const host = $("#viewport"),
  renderer = new THREE.WebGLRenderer({
    alpha: true,
    antialias: true,
    powerPreference: "high-performance",
  });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.setClearColor(0, 0);
renderer.outputColorSpace = THREE.SRGBColorSpace;
host.append(renderer.domElement);
const scene = new THREE.Scene(),
  camera = new THREE.PerspectiveCamera(30, 1, 0.01, 100),
  orbit = new OrbitControls(camera, renderer.domElement);
orbit.enableDamping = true;
orbit.enabled = !obs;
scene.add(new THREE.HemisphereLight(0xffffff, 0xb29d87, 2));
const sun = new THREE.DirectionalLight(0xfff2df, 2.5);
sun.position.set(2, 4, 4);
scene.add(sun);
const loader = new GLTFLoader();
loader.register((parser) => new VRMLoaderPlugin(parser));
let model = null,
  vrm = null,
  mixer = null,
  manifest = null,
  state = null,
  epoch = 0,
  frames = 0,
  last = performance.now(),
  lastReceipt = 0,
  height = 1.7,
  active = null,
  expression = null,
  mouth = 0,
  loadingSha = null,
  audioRole = false,
  presentation = null,
  standardMotion = null,
  rawBlend = null,
  singing = false;
const audioPreferenceKey = "avatar-stage-audio-opt-in";
const audioPreference = {
  read() {
    try {
      return sessionStorage.getItem(audioPreferenceKey) === "enabled";
    } catch {
      return false;
    }
  },
  save() {
    try {
      sessionStorage.setItem(audioPreferenceKey, "enabled");
    } catch {}
  },
};
let audioEnablePending = null,
  audioRestoreAttempted = false,
  audioBlocked = false;
const bones = new Map(),
  rest = new Map(),
  pose = new Map(),
  morphs = [],
  motionCache = new Map(),
  commandScopes = new Map(),
  nativeClips = new Map();
const notify = (text) => ($("#status").textContent = text);
async function call(tool, args, requestId = crypto.randomUUID()) {
  const r = await fetch("/api/call", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tool, args, requestId }),
  });
  const data = await r.json();
  if (!r.ok) throw Error(data.error);
  return data.result;
}
async function receipt(status, eventId, error) {
  if (!manifest) return;
  const data = {
    sessionId,
    role:
      commandScopes.get(eventId) === "preview"
        ? "preview"
        : obs || audioRole
          ? "broadcast"
          : "preview",
    status,
    surface: obs ? "obs" : "control",
    eventId,
    error,
    avatarId: manifest.id,
    avatarSha256: manifest.sha256,
    frames,
    audioTimeMs: audio.music ? audio.music.currentTime * 1000 : undefined,
  };
  const r = await fetch("/api/receipt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!r.ok && status !== "heartbeat") notify("回执未确认");
  return r.ok;
}
const audio = new AudioOutput({
  sessionId,
  receipt,
  onMouth: (value) => (mouth = value),
  onLyric: (text) => ($("#lyric").textContent = text),
  onState: (text) => {
    $("#audioStatus").textContent = text;
    document.body.dataset.audioContext = audio.context?.state ?? "not-created";
  },
});
const performanceCues = new PerformanceCues(receipt);
let mirroredAudio = null,
  performanceWeights = {},
  playback = { playing: false, kind: "idle", actionId: null };
function view(mode) {
  const damping = orbit.enableDamping;
  orbit.enableDamping = false;
  orbit.update();
  const y = mode === "portrait" ? height * 0.73 : height * 0.52,
    dist = mode === "portrait" ? height * 1.35 : height * 2.25;
  orbit.target.set(0, y, 0);
  camera.position.set(0, y, dist);
  orbit.update();
  orbit.enableDamping = damping;
}
function dispose() {
  document.body.dataset.loaded = "false";
  $("#enableAudio").disabled = true;
  delete document.body.dataset.presentation;
  active = null;
  audio.stop();
  performanceCues.reset();
  mirroredAudio = null;
  bones.clear();
  rest.clear();
  pose.clear();
  morphs.length = 0;
  presentation?.dispose?.();
  presentation = null;
  standardMotion?.dispose();
  standardMotion = null;
  if (model) {
    scene.remove(model);
    VRMUtils.deepDispose(model);
  }
  model = null;
  vrm = null;
  mixer = null;
  motionCache.clear();
  nativeClips.clear();
}
async function load(avatar) {
  if (!avatar) {
    notify("请先安装人物预设");
    return;
  }
  if (
    (manifest?.sha256 === avatar.sha256 && model) ||
    loadingSha === avatar.sha256
  )
    return;
  const ticket = ++epoch;
  loadingSha = avatar.sha256;
  dispose();
  manifest = avatar;
  notify("正在载入 " + avatar.label);
  let gltf, pendingPresentation, pendingMotion;
  try {
    const response = await fetch(avatar.url);
    if (!response.ok) throw Error("Avatar download failed");
    const bytes = await response.arrayBuffer(),
      hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    if (hash !== avatar.sha256) throw Error("Avatar content hash mismatch");
    gltf = await loader.parseAsync(bytes, "");
    if (ticket !== epoch) {
      VRMUtils.deepDispose(gltf.scene);
      return;
    }
    const pendingVRM = gltf.userData.vrm ?? null;
    const pendingModel = gltf.scene;
    if (pendingVRM) VRMUtils.rotateVRM0(pendingVRM);
    const pendingMixer = new THREE.AnimationMixer(pendingModel);
    // Explicit deployment renderer modules are keyed by immutable avatar hash.
    // Public packages contain no character-specific appearance or rig rules.
    const profiles = JSON.parse(
      document.querySelector("#avatar-renderer-profiles")?.textContent || "{}",
    );
    const profile = profiles[avatar.sha256];
    if (profile) {
      if (!profile.module?.startsWith("data:text/javascript;base64,"))
        throw Error("Renderer profile must be an explicitly installed module");
      const { createPresentation } = await import(profile.module);
      if (ticket !== epoch) {
        VRMUtils.deepDispose(pendingModel);
        return;
      }
      pendingPresentation = await createPresentation({
        model: pendingModel,
        animations: gltf.animations,
        mixer: pendingMixer,
        THREE,
        vrm: pendingVRM,
        avatar,
      });
    }
    const motionIndex = avatar.motionLibraryUrl
      ? await (await fetch(avatar.motionLibraryUrl)).json()
      : JSON.parse(
          document.querySelector("#avatar-motion-presets")?.textContent || "{}",
        )[avatar.sha256];
    if (pendingVRM && !profile && motionIndex) {
      pendingMotion = new VRMMotionLayer(pendingVRM, pendingMixer);
      try {
        await pendingMotion.load(motionIndex);
      } catch (error) {
        pendingMotion.dispose();
        pendingMotion = null;
        document.body.dataset.motionError = error.message;
      }
    }
    if (ticket !== epoch) {
      pendingPresentation?.dispose?.();
      pendingMotion?.dispose();
      VRMUtils.deepDispose(pendingModel);
      return;
    }
    // The render loop must not own the model until asynchronous textures and the
    // private presentation are ready. Early generic VRM updates can change the
    // spring rest pose before the presentation captures it.
    vrm = pendingVRM;
    model = pendingModel;
    mixer = pendingMixer;
    presentation = pendingPresentation ?? null;
    standardMotion = pendingMotion ?? null;
    document.body.dataset.motionLibrary = standardMotion
      ? String(standardMotion.clips.size) + " VRMA"
      : "procedural";
    $("#installedClips").replaceChildren(
      ...(avatar.capabilities.animationCatalog ?? []).map(
        (c) => new Option(c.label ?? c.bodyClip, c.bodyClip),
      ),
    );
    if (standardMotion?.idleName)
      $("#installedClips").value = "vrma:" + standardMotion.idleName;
    $("#playInstalledClip").disabled = !$("#installedClips").options.length;
    $("#installedClips").onchange?.();
    if (profile) document.body.dataset.presentation = profile.revision;
    model.traverse((o) => {
      o.frustumCulled = false;
      if (o.isMesh && o.morphTargetDictionary) morphs.push(o);
    });
    scene.add(model);
    const box = new THREE.Box3().setFromObject(model),
      center = box.getCenter(new THREE.Vector3());
    height = box.max.y - box.min.y;
    model.position.x -= center.x;
    model.position.z -= center.z;
    model.position.y -= box.min.y;
    for (const name of avatar.capabilities.bones) {
      const node =
        presentation?.getBoneNode?.(name) ??
        vrm?.humanoid.getNormalizedBoneNode(name) ??
        model.getObjectByName(avatar.humanoid[name]);
      if (node) {
        bones.set(name, node);
        rest.set(name, node.quaternion.clone());
        pose.set(name, node.quaternion.clone());
      }
    }
    if (bones.get("hips")) {
      model.updateMatrixWorld(true);
      const hips = bones.get("hips").getWorldPosition(new THREE.Vector3());
      model.position.x -= hips.x;
      model.position.z -= hips.z;
    }
    for (const clip of gltf.animations) nativeClips.set(clip.name, clip);
    presentation?.ready?.();
    view(obs ? "portrait" : "full");
    expression = null;
    document.body.dataset.loaded = "true";
    document.body.dataset.avatarId = avatar.id;
    document.body.dataset.avatarSha256 = avatar.sha256;
    $("#credit").textContent = avatar.attribution;
    $("#streamCredit").textContent = avatar.attribution;
    $("#expressions").replaceChildren();
    for (const name of avatar.capabilities.expressions.filter(
      (n) =>
        ![
          "aa",
          "ih",
          "ou",
          "ee",
          "oh",
          "blink",
          "blinkLeft",
          "blinkRight",
          "lookUp",
          "lookDown",
          "lookLeft",
          "lookRight",
        ].includes(n),
    )) {
      const b = document.createElement("button");
      b.textContent = name;
      b.onclick = () =>
        void safe(() =>
          call("avatar_control", {
            action: "perform",
            expression: name,
            intensity: Number($("#intensity").value),
            scope: obs ? "broadcast" : "preview",
          }),
        );
      $("#expressions").append(b);
    }
    notify(avatar.label + " · 已连接");
    await receipt("ready");
    $("#enableAudio").disabled = false;
    if ($("#obsAudio")) $("#obsAudio").disabled = false;
  } catch (error) {
    if (gltf && ticket === epoch && model === gltf.scene) {
      dispose();
    } else if (gltf && model !== gltf.scene) {
      pendingPresentation?.dispose?.();
      pendingMotion?.dispose();
      VRMUtils.deepDispose(gltf.scene);
    }
    throw error;
  } finally {
    if (ticket === epoch) loadingSha = null;
  }
}
function setExpression(name, value) {
  if (vrm) {
    vrm.expressionManager?.setValue(name, value);
    return;
  }
  for (const mesh of morphs) {
    const key = manifest.expressions[name];
    if (key in mesh.morphTargetDictionary)
      mesh.morphTargetInfluences[mesh.morphTargetDictionary[key]] = value;
  }
}
function leaveRawMotion() {
  if (vrm && active?.clipAction && !active.normalized) {
    rawBlend = {
      start: performance.now(),
      bones: [...bones.keys()]
        .map((name) => {
          const node = vrm.humanoid.getRawBoneNode(name);
          return node
            ? {
                node,
                rotation: node.quaternion.clone(),
                position: node.position.clone(),
              }
            : null;
        })
        .filter(Boolean),
    };
    vrm.humanoid.autoUpdateHumanBones = true;
    active.clipAction.stop();
    standardMotion?.resume();
  }
}
async function command(c) {
  if (c.avatarId && c.avatarId !== manifest?.id && c.kind !== "select") return;
  if (c.expiresAt < Date.now() || (obs && c.scope === "preview")) return;
  const ticket = epoch;
  if (c.eventId) {
    commandScopes.set(c.eventId, c.scope);
    if (commandScopes.size > 100)
      commandScopes.delete(commandScopes.keys().next().value);
  }
  try {
    if (c.kind === "select") {
      await load(c.avatar);
      await receipt("applied", c.eventId);
      return;
    }
    if (c.kind === "speech" || c.kind === "music") {
      if (c.targetSession === sessionId) await audio.command(c);
      return;
    }
    if (c.kind === "presentation") {
      performanceCues.receive(c);
      return;
    }
    if (!model) throw Error("Avatar is not loaded");
    const mappedClip = presentation?.gesture?.(c.gesture);
    if (!c.bodyClip && mappedClip) c = { ...c, bodyClip: mappedClip };
    expression = c.expression ?? null;
    if (
      (c.bodyClip?.startsWith("vrma:") &&
        standardMotion?.hasClip(c.bodyClip)) ||
      (!c.bodyClip && standardMotion?.has(c.gesture))
    ) {
      leaveRawMotion();
      const action = c.bodyClip
        ? standardMotion.playClip(c.bodyClip, c.durationMs)
        : standardMotion.play(c.gesture, c.durationMs);
      vrm.humanoid.autoUpdateHumanBones = true;
      active = {
        ...c,
        start: performance.now(),
        durationMs: action.getClip().duration * 1000,
        clipAction: action,
        normalized: true,
      };
      document.body.dataset.gesture = c.gesture;
      document.body.dataset.motionClip = action.getClip().name;
      await receipt("playing", c.eventId);
      return;
    }
    if (c.kind === "motion" || c.bodyClip) {
      let clip = c.bodyClip
        ? nativeClips.get(c.bodyClip)
        : motionCache.get(c.clipId);
      if (c.bodyClip && !clip) throw Error("Native clip is unavailable");
      if (!clip) {
        const r = await fetch(c.url);
        if (!r.ok) throw Error("Motion unavailable");
        const data = await r.json();
        const raw = data.clip ?? data;
        clip = THREE.AnimationClip.parse(
          presentation?.prepareClip?.(raw, c.clipId) ?? {
            ...raw,
            uuid: "avatar-motion-" + c.clipId,
          },
        );
        motionCache.set(c.clipId, clip);
      }
      if (ticket !== epoch) return;
      if (!presentation) {
        if (standardMotion) {
          leaveRawMotion();
          standardMotion.pause();
        } else mixer.stopAllAction();
      }
      // Blend into the raw generated pose instead of snapping all joints.
      rawBlend = vrm
        ? {
            start: performance.now(),
            bones: [...bones.keys()]
              .map((name) => {
                const node = vrm.humanoid.getRawBoneNode(name);
                return node
                  ? {
                      node,
                      rotation: node.quaternion.clone(),
                      position: node.position.clone(),
                    }
                  : null;
              })
              .filter(Boolean),
          }
        : null;
      if (vrm) vrm.humanoid.autoUpdateHumanBones = false;
      const action =
        presentation?.play?.(clip) ??
        mixer.clipAction(clip).reset().setLoop(THREE.LoopOnce, 1).play();
      action.clampWhenFinished = true;
      active = {
        ...c,
        start: performance.now(),
        durationMs: clip.duration * 1000,
        clipAction: action,
      };
      await receipt("playing", c.eventId);
      document.body.dataset.gesture = "generated-motion";
      return;
    }
    if (active?.clipAction) {
      leaveRawMotion();
      if (presentation) presentation.finish?.();
      else if (standardMotion) standardMotion.finish();
      else mixer.stopAllAction();
    }
    if (vrm) vrm.humanoid.autoUpdateHumanBones = true;
    active = {
      ...c,
      start: performance.now(),
      durationMs: c.durationMs ?? 2500,
    };
    expression = c.expression ?? null;
    await receipt("playing", c.eventId);
    document.body.dataset.gesture = c.gesture ?? "pose";
  } catch (e) {
    notify(e.message);
    await receipt("failed", c.eventId, e.message);
  }
}
function applyPose(dt, now) {
  if (!model) return;
  const elapsed = active
      ? active.clipAction
        ? active.clipAction.time
        : (now - active.start) / 1000
      : 0,
    duration = (active?.durationMs ?? 0) / 1000;
  document.body.dataset.motionPhase = !active
    ? "idle"
    : elapsed < duration * 0.25
      ? "entry"
      : elapsed < duration * 0.75
        ? "middle"
        : "exit";
  document.body.dataset.motionSeconds = active ? elapsed.toFixed(2) : "";
  let strength = active
    ? Math.min(1, elapsed / 0.28, Math.max(0, (duration - elapsed) / 0.35)) *
      (active.intensity ?? 1)
    : 0;
  if (active && elapsed >= duration - 0.0001) {
    void receipt("ended", active.eventId);
    leaveRawMotion();
    active = null;
    expression = null;
    strength = 0;
    document.body.dataset.gesture = "idle";
    if (presentation) presentation.finish?.();
    else if (standardMotion) standardMotion.finish();
    else mixer.stopAllAction();
    if (vrm) vrm.humanoid.autoUpdateHumanBones = true;
  }
  if (presentation) {
    presentation.frame(dt, now, {
      active,
      expression,
      mouth,
      singing,
      strength,
      speech: audio.speechPlaying ? { actionId: audio.current } : null,
    });
    model.updateMatrixWorld(true);
    if (frames % 6 === 0 && bones.get("rightHand"))
      document.body.dataset.rightHand = JSON.stringify(
        bones.get("rightHand").getWorldPosition(new THREE.Vector3()).toArray(),
      );
    return;
  }
  const targets = {};
  if (vrm) {
    targets.leftUpperArm = [0, 0, -1.28];
    targets.rightUpperArm = [0, 0, 1.28];
    targets.leftLowerArm = [0, -0.08, 0];
    targets.rightLowerArm = [0, 0.08, 0];
  }
  const t = now / 1000;
  const standardPlaying =
    standardMotion && (!active?.clipAction || active.normalized);
  if (standardPlaying) {
    standardMotion.resume();
    standardMotion.setActivity(
      playback.playing ? playback.kind : "idle",
      playback.timeMs,
      playback.loopClip,
    );
    standardMotion.update(dt);
    document.body.dataset.activityClip = standardMotion.baseName ?? "";
    document.body.dataset.performerClip = standardMotion.current?.action.getClip().name ?? standardMotion.baseName ?? "";
    document.body.dataset.performerSeconds = (standardMotion.current?.action.time ?? standardMotion.base?.time ?? 0).toFixed(2);
    // Keep authored body/finger motion. Small procedural overlays affect only
    // requested joints; they never replace every bone with the T-pose.
    const overlay = active?.bones
      ? Object.fromEntries(
          Object.entries(active.bones).map(([n, v]) => [
            n,
            v.map((x) => THREE.MathUtils.degToRad(x) * strength),
          ]),
        )
      : {};
    if (active?.gesture === "bow") overlay.spine = [0.38 * strength, 0, 0];
    if (!active?.clipAction)
      overlay.head ??= [
        Math.sin(t * 0.65) * 0.012,
        Math.sin(t * 0.37) * 0.025,
        0,
      ];
    standardMotion.applyOverlay(bones, overlay);
  } else if (!active?.clipAction) {
    targets.spine = [
      Math.sin(t * 1.3) * 0.007,
      0,
      Math.sin(t * 0.55) * (singing ? 0.045 : 0.012),
    ];
    targets.head = [Math.sin(t * 0.65) * 0.012, Math.sin(t * 0.37) * 0.025, 0];
    if (active?.bones)
      for (const [bone, angles] of Object.entries(active.bones))
        targets[bone] = angles.map(
          (v) => THREE.MathUtils.degToRad(v) * strength,
        );
    if (active?.gesture === "wave") {
      targets.rightUpperArm = [
        -0.15,
        0.12,
        THREE.MathUtils.lerp(1.28, 0.1, strength),
      ];
      targets.rightLowerArm = [0, 0.08, -1.5 * strength];
      targets.rightHand = [0, Math.sin(elapsed * 11) * 0.4 * strength, 0];
    }
    if (active?.gesture === "nod")
      targets.head = [Math.sin(elapsed * 7) * 0.19 * strength, 0, 0];
    if (active?.gesture === "bow") targets.spine = [0.38 * strength, 0, 0];
    if (active?.gesture === "cheer") {
      targets.leftUpperArm = [
        0,
        0,
        THREE.MathUtils.lerp(-1.28, 0.35, strength),
      ];
      targets.rightUpperArm = [
        0,
        0,
        THREE.MathUtils.lerp(1.28, -0.35, strength),
      ];
    }
    for (const [name, bone] of bones) {
      const target = rest
        .get(name)
        .clone()
        .multiply(
          new THREE.Quaternion().setFromEuler(
            new THREE.Euler(...(targets[name] ?? [0, 0, 0])),
          ),
        );
      bone.quaternion.slerp(target, 1 - Math.exp(-dt * 12));
      pose.get(name).copy(bone.quaternion);
    }
  } else mixer.update(dt);
  const blink = t % 4.7;
  for (const [name, weight] of Object.entries(
    expressionWeights({
      available: manifest.capabilities.expressions,
      expression,
      strength,
      singing,
      speechPlaying: audio.speechPlaying,
      mouth,
      automatic: performanceWeights,
      blink: blink < 0.18 ? Math.sin((blink / 0.18) * Math.PI) : 0,
    }),
  ))
    setExpression(name, weight);
  vrm?.update(dt);
  if (rawBlend) {
    const fraction = Math.min(1, (now - rawBlend.start) / 300);
    for (const { node, rotation, position } of rawBlend.bones) {
      const target = node.quaternion.clone();
      node.quaternion.copy(rotation).slerp(target, fraction);
      const targetPosition = node.position.clone();
      node.position.copy(position).lerp(targetPosition, fraction);
    }
    if (fraction === 1) rawBlend = null;
  }
  model.updateMatrixWorld(true);
  if (frames % 6 === 0) {
    const hand =
      vrm?.humanoid.getRawBoneNode("rightHand") ?? bones.get("rightHand");
    if (hand)
      document.body.dataset.rightHand = JSON.stringify(
        hand
          .getWorldPosition(new THREE.Vector3())
          .toArray()
          .map((v) => Number(v.toFixed(4))),
      );
  }
}
async function safe(fn) {
  try {
    return await fn();
  } catch (e) {
    notify(e.message);
  }
}
for (const [gesture, label] of [
  ["wave", "挥手"],
  ["nod", "点头"],
  ["bow", "鞠躬"],
  ["cheer", "欢呼"],
  ["idle", "自然站姿"],
]) {
  const button = document.createElement("button");
  button.textContent = label;
  button.onclick = () =>
    void safe(() =>
      call("avatar_control", {
        action: "perform",
        gesture,
        intensity: Number($("#intensity").value),
        scope: obs ? "broadcast" : "preview",
      }),
    );
  $("#gestures").append(button);
}
$("#full").onclick = () => view("full");
$("#installedClips").onchange = () => {
  const clip = manifest?.capabilities.animationCatalog?.find(
    (c) => c.bodyClip === $("#installedClips").value,
  );
  $("#clipCredit").textContent = clip
    ? [clip.description, clip.license, clip.source].filter(Boolean).join(" · ")
    : "";
};
$("#playInstalledClip").onclick = () =>
  void safe(() =>
    call("avatar_control", {
      action: "perform",
      bodyClip: $("#installedClips").value,
      scope: obs ? "broadcast" : "preview",
    }),
  );
$("#portrait").onclick = () => view("portrait");
$("#avatars").onchange = () =>
  void safe(() =>
    call("avatar_control", { action: "select", avatarId: $("#avatars").value }),
  );
const enableAudio = () => {
  if (audioEnablePending) {
    // An automatic restore can be waiting for a gesture. The user's click must
    // still call resume synchronously, rather than reuse a blocked promise only.
    if (audio.context?.state !== "running")
      void audio.context?.resume().catch(() => {});
    return audioEnablePending;
  }
  audioRestoreAttempted = true;
  audioRole = true;
  audioBlocked = false;
  audioEnablePending = audio
    .enable(() => receipt("ready"))
    .then(() => {
      audioPreference.save();
      document.body.dataset.audioEnabled = "true";
      $("#enableAudio").textContent = "声音已开启";
      notify(manifest.label + " · 已连接");
      document.querySelector("#obsAudio")?.remove();
    })
    .catch((error) => {
      audioBlocked = true;
      audioRole = false;
      document.body.dataset.audioEnabled = "false";
      $("#audioStatus").textContent = error.message;
      $("#enableAudio").textContent = "点击开启声音";
      throw error;
    })
    .finally(() => {
      audioEnablePending = null;
    });
  return audioEnablePending;
};
$("#enableAudio").onclick = () => void safe(enableAudio);
if (obs) {
  const button = document.createElement("button");
  button.id = "obsAudio";
  button.disabled = true;
  button.textContent = "开启声音";
  Object.assign(button.style, {
    position: "fixed",
    bottom: "20px",
    right: "20px",
  });
  button.onclick = () => void safe(enableAudio);
  document.body.append(button);
}
$("#speak").onclick = () =>
  void safe(() =>
    call("avatar_voice", {
      action: "speak",
      text: $("#speechText").value,
      voice: $("#voices").value || undefined,
    }),
  );
$("#voices").onchange = () =>
  void safe(() =>
    call("avatar_voice", { action: "select", voice: $("#voices").value }),
  );
$("#interrupt").onclick = () =>
  void safe(() => call("avatar_voice", { action: "interrupt" }));
$("#generateMotion").onclick = () =>
  void safe(() =>
    call("avatar_motion", {
      action: "generate",
      prompt: $("#motionText").value,
      durationSec: 2,
      seed: 42,
    }),
  );
$("#playMusic").onclick = () =>
  void safe(() =>
    call("avatar_music", { action: "play", trackId: $("#tracks").value }),
  );
$("#stopMusic").onclick = () =>
  void safe(() => call("avatar_music", { action: "stop" }));
async function refresh() {
  state = await (await fetch("/api/state")).json();
  $("#protocol").textContent = state.protocol;
  $("#avatars").replaceChildren(
    ...state.avatars.map((a) => new Option(a.label, a.id)),
  );
  $("#avatars").value = state.activeAvatar?.id ?? "";
  const voice = $("#voices").value;
  $("#voices").replaceChildren(
    ...(state.voice.voices ?? []).map((v) => new Option(v, v)),
  );
  $("#voices").value = voice || state.voice.voice || "";
  const audioReady =
    state.audioOwner === sessionId && audio.context?.state === "running";
  document.body.dataset.audioEnabled = String(audioReady);
  document.body.dataset.audioContext = audio.context?.state ?? "not-created";
  if (!audioBlocked)
    $("#audioStatus").textContent = audioReady
      ? "本页正在输出音频"
      : state.audioOwner === sessionId
        ? "浏览器暂停了声音，请点击开启声音"
        : state.audioOwner
          ? "另一页面负责音频"
          : "尚未开启声音，请点击上方按钮";
  $("#enableAudio").textContent = audioReady ? "声音已开启" : "开启声音";
  await load(state.activeAvatar);
  // Remember only this tab's explicit opt-in. A new preview tab never takes
  // another renderer's lease. Autoplay denial is shown once, not retried forever.
  if (!audioRestoreAttempted && !audioEnablePending && manifest && model) {
    if (!audioPreference.read()) audioRestoreAttempted = true;
    else if (!state.audioOwner) void safe(enableAudio);
  } else if (
    audioRole &&
    !audioBlocked &&
    !audioEnablePending &&
    !state.audioOwner &&
    audio.context?.state === "running"
  ) {
    void safe(enableAudio);
  }
  $("#motionJobs").replaceChildren();
  let jobs = state.motionJobs ?? [];
  if (state.activeAvatar?.capabilities.motionConfigured) {
    const library = await call("avatar_motion", {
      action: "search",
      limit: 30,
    });
    jobs = library.jobs.map((job) => ({ ...job, jobId: job.id }));
  }
  for (const job of jobs) {
    const row = document.createElement("div");
    row.className = "candidate";
    const labels = {
      queued: "排队中",
      generating: "生成中",
      ready: "已生成",
      review: "需检查",
      failed: "失败",
      cancelled: "已取消",
    };
    row.textContent =
      (job.title ?? job.jobId.slice(0, 8)) +
      " · " +
      (labels[job.status] ?? job.status) +
      (job.review === "approved" ? " · 已采用" : "");
    const buttons = document.createElement("div");
    buttons.className = "row";
    if (["ready", "review"].includes(job.status))
      for (const [action, label] of [
        ["preview", "预览"],
        ["approve", "采用"],
        ["play", "播放"],
      ]) {
        const b = document.createElement("button");
        b.textContent = label;
        b.onclick = () =>
          void safe(() => call("avatar_motion", { action, clipId: job.jobId }));
        buttons.append(b);
      }
    row.append(buttons);
    $("#motionJobs").append(row);
  }
  $("#songJobs").replaceChildren();
  for (const job of state.music.jobs ?? []) {
    const row = document.createElement("div");
    row.className = "candidate";
    row.textContent =
      (job.result?.title ?? job.request?.title ?? "") + " · " + job.state;
    if (job.provider === "fal" && job.state === "review") {
      const buttons = document.createElement("div");
      buttons.className = "row";
      for (const [action, label] of [
        ["preview", "试听"],
        ["approve", "采用入库"],
        ["reject", "不采用"],
      ]) {
        const b = document.createElement("button");
        b.textContent = label;
        b.onclick = () =>
          void safe(() =>
            call(
              "avatar_music",
              action === "preview"
                ? { action, trackId: job.result.trackId }
                : { action, jobId: job.jobId },
            ),
          );
        buttons.append(b);
      }
      row.append(buttons);
    }
    $("#songJobs").append(row);
  }
  const catalog = await call("avatar_music", { action: "list" });
  const track = $("#tracks").value;
  $("#tracks").replaceChildren(
    ...catalog.tracks.map((t) => new Option(t.title, t.id)),
  );
  if (track) $("#tracks").value = track;
}
const stream = new EventSource("/events");
stream.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (
    message.type === "avatar.action" &&
    ["speech", "music-play"].includes(message.data.kind)
  ) {
    const row = message.data;
    if (row.status === "playing")
      mirroredAudio = {
        actionId: row.id,
        kind: row.kind === "speech" ? "speaking" : "singing",
        playing: true,
        at: performance.now(),
        timeMs: row.evidence?.audioTimeMs ?? 0,
      };
    else if (
      ["completed", "failed", "cancelled"].includes(row.status) &&
      mirroredAudio?.actionId === row.id
    )
      mirroredAudio = null;
  }
  if (message.type === "cancel" && message.data.eventId)
    performanceCues.cancel(message.data.eventId);
  if (message.type === "snapshot") void safe(() => refresh());
  if (message.type === "command") void command(message.data);
  if (
    message.type === "cancel" &&
    (message.data.allBody || active?.eventId === message.data.eventId)
  ) {
    leaveRawMotion();
    if (presentation) presentation.finish?.();
    else if (standardMotion) standardMotion.finish();
    else mixer?.stopAllAction();
    active = null;
    expression = null;
    if (vrm) vrm.humanoid.autoUpdateHumanBones = true;
  }
  if (
    message.type === "audio.cut" &&
    (!message.data.eventId || audio.current === message.data.eventId)
  )
    audio.stop();
};
stream.onerror = () => {
  audio.stop();
  notify("演出连接中断，等待恢复");
};
setInterval(() => void safe(() => refresh()), 4000);
// Rendering can be throttled while the page is covered; keep the opted-in
// output lease separate from animation frames and reclaim only an empty lease.
setInterval(() => {
  if (audioRole) void safe(() => receipt("heartbeat"));
}, 4000);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void safe(() => refresh());
});
new ResizeObserver(() => {
  renderer.setSize(host.clientWidth, host.clientHeight);
  camera.aspect = host.clientWidth / host.clientHeight;
  camera.updateProjectionMatrix();
}).observe(host);
renderer.setAnimationLoop(() => {
  const now = performance.now(),
    rawDt = (now - last) / 1000,
    dt = Math.min(0.05, rawDt);
  last = now;
  const sound = audio.update();
  playback = sound.playing
    ? sound
    : !audioRole && mirroredAudio
      ? {
          ...mirroredAudio,
          timeMs: mirroredAudio.timeMs + performance.now() - mirroredAudio.at,
        }
      : { playing: false, kind: "idle", actionId: null, timeMs: 0 };
  const cue = performanceCues.update(playback, dt, {
    busy: !!active,
    isLoop: (name) =>
      standardMotion?.metadata[String(name).replace(/^vrma:/, "")]?.loop ===
      true,
    play: (name) => {
      if (standardMotion?.hasClip(name)) {
        const layer = standardMotion,
          action = layer.playClip(name);
        return () => {
          if (layer.current?.action === action) layer.finish();
        };
      }
    },
  });
  playback.loopClip = cue.loopClip;
  performanceWeights = cue.weights;
  document.body.dataset.performanceCue = cue.cueId ?? "";
  singing = sound.singing && !!audio.music && !audio.music.paused;
  applyPose(dt, now);
  orbit.update();
  renderer.render(scene, camera);
  frames++;
  if (now - lastReceipt > 1000) {
    lastReceipt = now;
    $("#fps").textContent = Math.round(1 / Math.max(0.001, rawDt)) + " FPS";
    document.body.dataset.frames = String(frames);
    document.body.dataset.singing = String(singing);
    void receipt("heartbeat");
  }
});
window.addEventListener("pagehide", () => {
  audio.stop();
  stream.close();
});
