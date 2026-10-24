import { expect, it, vi, afterEach } from "vitest";
import * as THREE from "three";
import type { EventEnvelope } from "cortico/core/types.ts";
import { DesktopReplySpeech } from "../src/desktop-reply-speech.ts";
import {
  PerformanceDirector,
  presentationQuestion,
  type DecisionInput,
} from "../src/core/performance-director.ts";
// @ts-expect-error browser module has no declarations
import { VRMMotionLayer } from "../web/vrm-motion.js";
afterEach(() => vi.useRealTimers());
const event = (cursor: number, extra: Record<string, unknown> = {}) =>
  ({
    source: "pet",
    type: "pet.self",
    origin: "external",
    cursor,
    run: "run-a",
    ts: new Date().toISOString(),
    text: "literal reply",
    meta: { kind: "say", via: "tool", beats: [{ text: "Hello, companion." }] },
    ...extra,
  }) as EventEnvelope;
it("speaks only literal manual replies, once per source cursor, and never mirrors its own presentation", async () => {
  const calls: Array<{ text: string; id: string }> = [],
    logs: unknown[] = [];
  const mirror = new DesktopReplySpeech({
    config: () => ({ enabled: true, sources: "pet" }),
    speak: async (text, id) => {
      calls.push({ text, id });
      return { accepted: true, id: "voice-a", status: "queued" };
    },
    log: (d) => logs.push(d),
  });
  const e = event(1);
  mirror.observe(e);
  mirror.observe(e);
  mirror.observe(
    event(2, {
      meta: {
        kind: "say",
        via: "presentation",
        beats: [{ text: "Do not echo me" }],
      },
    }),
  );
  mirror.observe(event(3, { source: "unselected" }));
  mirror.observe(
    event(4, {
      meta: { kind: "activity", via: "tool", text: "internal thoughts" },
    }),
  );
  await Promise.resolve();
  expect(calls).toEqual([
    { text: "Hello, companion.", id: "desktop-reply:run-a:1" },
  ]);
  expect(logs[0]).toMatchObject({ accepted: true, status: "queued" });
  mirror.observe(event(6,{meta:{kind:'ask',via:'tool',question:'Would you like to continue?'}}));
  await Promise.resolve();expect(calls[1]).toEqual({text:'Would you like to continue?',id:'desktop-reply:run-a:6'});
  mirror.stop();
  mirror.observe(event(5));
  expect(calls).toHaveLength(2);
});
it("keeps authored aliases and manual-only motions out of repeated automatic choices", () => {
  const q = presentationQuestion(
    "Thanks",
    "speaking",
    {
      activeAvatar: {
        id: "figure",
        capabilities: {
          animationCatalog: [
            { bodyClip: "wave", key: "greeting", auto: true },
            { bodyClip: "alias", key: "greeting", auto: true },
            { bodyClip: "kneel", key: "apology", auto: false },
            { bodyClip: "sing", key: "song", auto: true, tags: ["singing"] },
          ],
        },
      },
    },
    [
      {
        cursor: 17,
        ts: new Date().toISOString(),
        source: "voxel",
        type: "voxel.result",
        text: "A visitor arrived.",
      },
    ],
  );
  expect([...q.clips.values()].map((c) => c.bodyClip)).toEqual(["wave"]);
  expect(q.input.state).toMatchObject({
    recentFacts: [{ source: "voxel", cursor: 17 }],
  });
});
function answer(input: DecisionInput) {
  return {
    answers: Object.fromEntries(
      Object.entries(input.questions).map(([name, q]) => {
        const choice = Object.keys(q.criteria).at(-1)!;
        return [
          name,
          {
            choice,
            probabilities: Object.fromEntries(
              Object.keys(q.criteria).map((k) => [k, k === choice ? 1 : 0]),
            ),
          },
        ];
      }),
    ),
  };
}
it("rejects a silent reaction if manual control changes its admitted version while the model is running", async () => {
  let revision = 1,
    release!: (value: ReturnType<typeof answer>) => void,
    question!: DecisionInput;
  const react = vi.fn(async () => ({ accepted: true }));
  const director = new PerformanceDirector({
    config: () => ({
      enabled: true,
      provider: "local",
      timeoutMs: 1200,
      reactionSources: "voxel",
      reactionIntervalMs: 0,
    }),
    decide: {
      request: (input) => {
        question = input;
        return new Promise((resolve) => (release = resolve));
      },
    },
    state: () => ({
      foreground: null,
      busy: false,
      cueVersion: revision,
      activeAvatar: { id: "a", capabilities: { expressions: ["happy"] } },
    }),
    attach: async () => ({}),
    react,
    log() {},
  });
  director.observe({
    ...event(3),
    source: "voxel",
    type: "voxel.result",
    origin: "external",
    text: "A real new result.",
  });
  director.tick();
  revision++;
  release(answer(question));
  await Promise.resolve();
  await Promise.resolve();
  expect(react).not.toHaveBeenCalled();
});
it("masks base wrists while preserving real authored gestures, then returns both wrists to neutral", () => {
  const root = new THREE.Group(),
    left = new THREE.Object3D(),
    right = new THREE.Object3D(),
    arm = new THREE.Object3D();
  left.name = "left-wrist";
  right.name = "right-wrist";
  arm.name = "arm";
  root.add(left, right, arm);
  const layer = new VRMMotionLayer(
    {
      humanoid: {
        getNormalizedBoneNode: (name: string) =>
          name === "leftHand" ? left : right,
      },
    },
    new THREE.AnimationMixer(root),
    { baseExcludeBones: ["leftHand", "rightHand"] },
  );
  const track = (node: THREE.Object3D, angle: number) =>
    new THREE.QuaternionKeyframeTrack(
      node.name + ".quaternion",
      [0, 2],
      [
        ...new THREE.Quaternion()
          .setFromAxisAngle(new THREE.Vector3(1, 0, 0), angle)
          .toArray(),
        ...new THREE.Quaternion()
          .setFromAxisAngle(new THREE.Vector3(1, 0, 0), angle)
          .toArray(),
      ],
    );
  layer.clips.set(
    "idle",
    new THREE.AnimationClip("idle", 2, [
      track(left, 2),
      track(right, 2.7),
      track(arm, 0.3),
    ]),
  );
  layer.idleName = "idle";
  layer.activities = {};
  layer.setActivity("idle");
  for (let i = 0; i < 60; i++) layer.update(1 / 60);
  expect(left.quaternion.angleTo(new THREE.Quaternion())).toBeLessThan(1e-6);
  expect(right.quaternion.angleTo(new THREE.Quaternion())).toBeLessThan(1e-6);
  expect(arm.rotation.x).toBeCloseTo(0.3);
  layer.clips.set(
    "gesture",
    new THREE.AnimationClip("gesture", 2, [
      track(left, 0.8),
      track(right, -0.6),
    ]),
  );
  layer.playClip("gesture");
  for (let i = 0; i < 60; i++) layer.update(1 / 60);
  expect(left.rotation.x).toBeCloseTo(0.8);
  expect(right.rotation.x).toBeCloseTo(-0.6);
  for (let i = 0; i < 180; i++) layer.update(1 / 60);
  expect(left.rotation.x).toBeCloseTo(0);
  expect(right.rotation.x).toBeCloseTo(0);
  expect(layer.clips.get("idle").tracks).toHaveLength(3);
  layer.dispose();
});
