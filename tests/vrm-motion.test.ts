import { expect, it } from "vitest";
import * as THREE from "three";
// @ts-expect-error browser module uses pinned Three.js via the build import map
import { VRMMotionLayer } from "../web/vrm-motion.js";

it.each([true, false])("does not accumulate procedural head rotation when a clip's head track is constant or absent (%s)", (hasHeadTrack) => {
  const model = new THREE.Group(), head = new THREE.Object3D();
  head.name = "head";
  model.add(head);
  const layer = new VRMMotionLayer({}, new THREE.AnimationMixer(model));
  head.rotation.y = 0.3;
  const clip = new THREE.AnimationClip("constant", 4, hasHeadTrack ? [
    new THREE.QuaternionKeyframeTrack("head.quaternion", [0, 4], [
      ...head.quaternion.toArray(), ...head.quaternion.toArray(),
    ]),
  ] : []);
  layer.idle = layer.mixer.clipAction(clip).play();
  const base = head.quaternion.clone(), bones = new Map([["head", head]]);
  const offset = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.012, 0.025, 0));
  for (let i = 0; i < 600; i++) {
    layer.update(1 / 60);
    layer.applyOverlay(bones, {head: [0.012, 0.025, 0]});
    expect(head.quaternion.angleTo(base.clone().multiply(offset))).toBeLessThan(1e-6);
  }
  layer.pause();
  expect(head.quaternion.angleTo(base)).toBeLessThan(1e-6);
  head.rotation.x = 0.8;
  const rawPose = head.quaternion.clone();
  layer.update(1 / 60);
  expect(head.quaternion.angleTo(rawPose)).toBeLessThan(1e-6);
  layer.dispose();
});

it("crossfades an authored gesture and returns to the live idle without a T-pose frame", () => {
  const model = new THREE.Group(),
    bone = new THREE.Object3D();
  bone.name = "hand";
  model.add(bone);
  const mixer = new THREE.AnimationMixer(model);
  const layer = new VRMMotionLayer({}, mixer);
  const idle = new THREE.AnimationClip("idle", 4, [
    new THREE.NumberKeyframeTrack("hand.rotation[z]", [0, 4], [0.2, 0.2]),
  ]);
  const wave = new THREE.AnimationClip("wave", 2, [
    new THREE.NumberKeyframeTrack(
      "hand.rotation[z]",
      [0, 1, 2],
      [0.9, 1.4, 0.9],
    ),
  ]);
  layer.clips.set("idle", idle);
  layer.clips.set("wave", wave);
  layer.gestures = { wave: "wave" };
  layer.idle = mixer
    .clipAction(idle)
    .setLoop(THREE.LoopRepeat, Infinity)
    .play();
  for (let i = 0; i < 30; i++) layer.update(1 / 60);
  expect(bone.rotation.z).toBeCloseTo(0.2);
  layer.play("wave", 2000);
  const samples: number[] = [];
  for (let i = 0; i < 150; i++) {
    layer.update(1 / 60);
    samples.push(bone.rotation.z);
  }
  expect(Math.max(...samples)).toBeGreaterThan(1.2);
  expect(Math.min(...samples)).toBeGreaterThan(0.19);
  expect(
    Math.max(...samples.slice(1).map((v, i) => Math.abs(v - samples[i]))),
  ).toBeLessThan(0.06);
  expect(samples.at(-1)).toBeCloseTo(0.2);
  layer.dispose();
});

it("keeps normalized animations disabled during raw generated motion, and resumes idle", () => {
  const model = new THREE.Group(),
    bone = new THREE.Object3D();
  bone.name = "hand";
  model.add(bone);
  const mixer = new THREE.AnimationMixer(model),
    layer = new VRMMotionLayer({}, mixer);
  const idle = new THREE.AnimationClip("idle", 4, [
    new THREE.NumberKeyframeTrack("hand.rotation[z]", [0, 4], [0.2, 0.2]),
  ]);
  layer.clips.set("idle", idle);
  layer.idle = mixer.clipAction(idle).play();
  layer.update(0.1);
  layer.pause();
  bone.rotation.z = 1;
  layer.update(0.1);
  expect(bone.rotation.z).toBe(1);
  layer.resume();
  for (let i = 0; i < 40; i++) layer.update(1 / 60);
  expect(bone.rotation.z).toBeCloseTo(0.2);
  layer.dispose();
});

it("rejects an animation whose bytes do not match the immutable manifest", async () => {
  const layer = new VRMMotionLayer(
    {},
    new THREE.AnimationMixer(new THREE.Group()),
  );
  await expect(
    layer.load(
      { clips: { idle: { url: "/local.vrma", sha256: "wrong" } } },
      async () => new Uint8Array([1, 2, 3]).buffer,
    ),
  ).rejects.toThrow("hash mismatch");
});

it("changes speech/song base on the audio clock, returns to idle and preserves manual gestures", () => {
  const model = new THREE.Group(),
    bone = new THREE.Object3D();
  bone.name = "hand";
  model.add(bone);
  const mixer = new THREE.AnimationMixer(model),
    layer = new VRMMotionLayer({}, mixer);
  for (const [name, angle] of [
    ["idle", 0.2],
    ["talk", 0.4],
    ["song", 0.7],
    ["wave", 1.1],
  ] as const)
    layer.clips.set(
      name,
      new THREE.AnimationClip(name, 4, [
        new THREE.NumberKeyframeTrack(
          "hand.rotation[z]",
          [0, 4],
          [angle, angle],
        ),
      ]),
    );
  layer.idleName = "idle";
  layer.activities = { speaking: "talk", singing: "song" };
  layer.setActivity("idle");
  for (let i = 0; i < 30; i++) layer.update(1 / 60);
  layer.setActivity("singing", 2200);
  for (let i = 0; i < 30; i++) layer.update(1 / 60);
  expect(bone.rotation.z).toBeCloseTo(0.7);
  expect(layer.baseName).toBe("song");
  expect(layer.base.time).toBeCloseTo(2.7);
  layer.playClip("vrma:wave");
  layer.setActivity("speaking");
  for (let i = 0; i < 30; i++) layer.update(1 / 60);
  expect(bone.rotation.z).toBeCloseTo(1.1);
  expect(layer.baseName).toBe("talk");
  layer.finish();
  layer.setActivity("idle");
  for (let i = 0; i < 40; i++) layer.update(1 / 60);
  expect(bone.rotation.z).toBeCloseTo(0.2);
  expect(layer.retiring).toHaveLength(0);
  layer.dispose();
});

it("preserves the clamped final time until the page can reconcile completion before advancing the next frame", () => {
  const model = new THREE.Group(),
    bone = new THREE.Object3D();
  bone.name = "hand";
  model.add(bone);
  const layer = new VRMMotionLayer({}, new THREE.AnimationMixer(model));
  layer.clips.set(
    "wave",
    new THREE.AnimationClip("wave", 2, [
      new THREE.NumberKeyframeTrack("hand.rotation[z]", [0, 2], [0.1, 0.5]),
    ]),
  );
  const action = layer.playClip("wave");
  let completed = false;
  for (let i = 0; i < 180; i++) {
    // The page observes the previous frame before asking its layer to update.
    if (action.time >= action.getClip().duration - 0.0001) {
      completed = true;
      break;
    }
    layer.update(1 / 60);
  }
  expect(completed).toBe(true);
  for (let i = 0; i < 60; i++) layer.update(1 / 60);
  expect(layer.retiring).toHaveLength(0);
  layer.dispose();
});
