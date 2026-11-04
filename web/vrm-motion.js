import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import {
  VRMAnimationLoaderPlugin,
  VRMLookAtQuaternionProxy,
  createVRMAnimationClip,
} from "@pixiv/three-vrm-animation";

/** Standard VRMA playback. Per-avatar indexes contain data, never rig scripts. */
export class VRMMotionLayer {
  constructor(vrm, mixer, { baseExcludeBones = [] } = {}) {
    this.vrm = vrm;
    this.mixer = mixer;
    this.clips = new Map();
    this.idle = null;
    this.base = null;
    this.baseName = null;
    this.current = null;
    this.retiring = [];
    this.paused = false;
    this.time = 0;
    this.fade = 0.4;
    this.overlays = new Map();
    this.baseExcluded = new Set(
      baseExcludeBones
        .map((name) => vrm.humanoid.getNormalizedBoneNode(name)?.name)
        .filter(Boolean),
    );
    this.baseClips = new Map();
  }
  baseClip(name) {
    const original = this.clips.get(name);
    if (!original || !this.baseExcluded.size) return original;
    if (!this.baseClips.has(name)) {
      const clip = original.clone();
      clip.name += ":base";
      clip.tracks = clip.tracks.filter(
        (track) =>
          !this.baseExcluded.has(
            track.name.slice(0, track.name.lastIndexOf(".")),
          ),
      );
      this.baseClips.set(name, clip);
    }
    return this.baseClips.get(name);
  }
  /** Remove the previous frame's additive pose before the mixer samples again.
   * Three may skip writing an unchanged track, and some clips omit a joint.
   * Leaving that joint modified would accumulate the overlay every frame.
   */
  restoreOverlay() {
    for (const [bone, rotation] of this.overlays)
      bone.quaternion.copy(rotation);
    this.overlays.clear();
  }
  applyOverlay(bones, targets) {
    this.restoreOverlay();
    for (const [name, angles] of Object.entries(targets)) {
      const bone = bones.get(name);
      if (!bone) continue;
      this.overlays.set(bone, bone.quaternion.clone());
      bone.quaternion.multiply(
        new THREE.Quaternion().setFromEuler(new THREE.Euler(...angles)),
      );
    }
  }
  async load(
    index,
    read = async (url) => {
      const r = await fetch(url);
      if (!r.ok) throw Error("VRMA animation download failed");
      return r.arrayBuffer();
    },
  ) {
    const loader = new GLTFLoader();
    loader.register((parser) => new VRMAnimationLoaderPlugin(parser));
    if (
      this.vrm.lookAt &&
      !this.vrm.scene.children.some(
        (o) => o instanceof VRMLookAtQuaternionProxy,
      )
    ) {
      this.lookAtProxy = new VRMLookAtQuaternionProxy(this.vrm.lookAt);
      this.lookAtProxy.name = "VRMLookAtQuaternionProxy";
      this.vrm.scene.add(this.lookAtProxy);
    }
    const entries = Object.entries(index.clips ?? {});
    for (const [name, spec] of entries) {
      const bytes = await read(spec.url);
      const hash = [
        ...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
      ]
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      if (hash !== spec.sha256) throw Error("VRMA animation hash mismatch");
      const gltf = await loader.parseAsync(bytes, "");
      const animation = gltf.userData.vrmAnimations?.[0];
      if (!animation)
        throw Error("A standard VRMC_vrm_animation clip is required");
      const clip = createVRMAnimationClip(animation, this.vrm);
      if (!Number.isFinite(clip.duration) || !(clip.duration > 0))
        throw Error("Invalid VRMA duration");
      clip.name = "vrma:" + name;
      this.clips.set(name, clip);
    }
    this.gestures = index.gestures ?? {};
    this.activities = index.activities ?? {};
    this.metadata = index.clips ?? {};
    this.idleName = index.idle;
    const idle = this.baseClip(index.idle);
    if (idle) {
      this.idle = this.mixer
        .clipAction(idle)
        .reset()
        .setLoop(THREE.LoopRepeat, Infinity);
      this.idle.play();
      this.base = this.idle;
      this.baseName = index.idle;
      this.mixer.update(0);
      this.vrm.humanoid.update();
    }
    return this;
  }
  has(gesture) {
    return !!this.clips.get(this.gestures?.[gesture]);
  }
  play(gesture, durationMs) {
    return this.playClip(this.gestures?.[gesture], durationMs);
  }
  hasClip(name) {
    return this.clips.has(String(name).replace(/^vrma:/, ""));
  }
  /** Playback activity follows the actual audio clock, never a queued speech flag. */
  setActivity(kind, timeMs = 0, preferred) {
    const key = String(
      preferred ?? this.activities[kind] ?? this.idleName,
    ).replace(/^vrma:/, "");
    const clip = this.baseClip(key);
    if (!clip || this.paused) return;
    if (this.baseName !== key) {
      const old = this.base;
      this.base = this.mixer
        .clipAction(clip)
        .reset()
        .setLoop(THREE.LoopRepeat, Infinity);
      this.base.enabled = true;
      this.base.setEffectiveTimeScale(1).setEffectiveWeight(1).play();
      if (this.current && !this.current.returning)
        this.base.setEffectiveWeight(0);
      else this.base.fadeIn(this.fade);
      old?.fadeOut(this.fade);
      if (old && old !== this.base)
        this.retiring.push({ action: old, until: this.time + this.fade });
      this.baseName = key;
    }
    if (kind === "singing" && !this.current) {
      const phase = Math.max(0, timeMs / 1000) % clip.duration;
      if (Math.abs(this.base.time - phase) > 0.15) this.base.time = phase;
    }
  }
  playClip(name, durationMs) {
    const original = this.clips.get(String(name).replace(/^vrma:/, ""));
    const clip = original?.clone();
    if (!clip) return null;
    this.resume();
    this.finish();
    const action = this.mixer.clipAction(clip).reset();
    action.enabled = true;
    action.clampWhenFinished = true;
    action.setLoop(THREE.LoopOnce, 1).setEffectiveWeight(1);
    const rate = durationMs ? clip.duration / (durationMs / 1000) : 1;
    action.setEffectiveTimeScale(THREE.MathUtils.clamp(rate, 0.7, 1.5));
    action.play().fadeIn(this.fade);
    this.base?.fadeOut(this.fade);
    this.current = { action, returning: false, transient: true };
    return action;
  }
  finish() {
    if (this.current) {
      const { action } = this.current;
      action.fadeOut(this.fade);
      this.retiring.push({
        action,
        until: this.time + this.fade,
        transient: true,
      });
      this.current = null;
    }
    if (this.base) {
      this.base.enabled = true;
      this.base
        .setEffectiveTimeScale(1)
        .setEffectiveWeight(1)
        .play()
        .fadeIn(this.fade);
    }
  }
  pause() {
    this.restoreOverlay();
    this.paused = true;
    for (const action of [
      this.base,
      this.idle,
      this.current?.action,
      ...this.retiring.map((r) => r.action),
    ])
      if (action) action.enabled = false;
  }
  resume() {
    if (!this.paused) return;
    this.paused = false;
    this.finish();
  }
  update(dt) {
    this.restoreOverlay();
    if (this.paused) return;
    this.base ??= this.idle;
    this.time += dt;
    const row = this.current;
    if (
      row &&
      !row.returning &&
      row.action.getClip().duration - row.action.time <=
        this.fade * row.action.getEffectiveTimeScale()
    ) {
      row.returning = true;
      row.action.fadeOut(this.fade);
      if (this.base) {
        this.base.enabled = true;
        this.base.setEffectiveWeight(1).play().fadeIn(this.fade);
      }
    }
    this.mixer.update(dt);
    if (row?.returning && row.action.time >= row.action.getClip().duration) {
      this.retiring.push({
        action: row.action,
        // Keep the clamped final time visible for the owner's next frame.
        // stop()/uncacheClip() immediately would reset time to zero before
        // the page can reconcile its active action and emit ended.
        until: this.time + this.fade,
        transient: true,
      });
      this.current = null;
    }
    for (const row of this.retiring)
      if (
        this.time >= row.until &&
        row.action !== this.current?.action &&
        row.action !== this.base
      ) {
        row.action.stop();
        if (row.transient) this.mixer.uncacheClip(row.action.getClip());
      }
    this.retiring = this.retiring.filter((r) => this.time < r.until);
  }
  dispose() {
    this.restoreOverlay();
    this.base?.stop();
    this.idle?.stop();
    this.current?.action.stop();
    for (const row of this.retiring) row.action.stop();
    for (const clip of this.clips.values()) this.mixer.uncacheClip(clip);
    for (const clip of this.baseClips.values()) this.mixer.uncacheClip(clip);
    this.baseClips.clear();
    this.clips.clear();
    this.lookAtProxy?.removeFromParent();
  }
}
