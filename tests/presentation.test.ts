import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadAnimationIndex } from "../src/core/animation-index.ts";
import {
  PerformanceDirector,
  presentationQuestion,
  type DecisionInput,
  type DecisionOutput,
} from "../src/core/performance-director.ts";
import { animationFixture } from "./fixtures/vrma.ts";
// @ts-expect-error browser modules are bundled without declarations
import { PerformanceCues } from "../web/performance-cues.js";
// @ts-expect-error browser modules are bundled without declarations
import { expressionWeights } from "../web/expression-weights.js";
const directories: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const dir of directories.splice(0))
    await rm(dir, { recursive: true, force: true });
});
async function installed(clip: ReturnType<typeof animationFixture>) {
  const dir = await mkdtemp(join(tmpdir(), "animation-index-"));
  directories.push(dir);
  const file = join(dir, "index.json");
  await writeFile(
    file,
    JSON.stringify({
      avatar: { activities: { speaking: "talk" }, clips: { talk: clip } },
    }),
  );
  return file;
}
it("reads actual GLB times when a valid VRMA omits accessor min/max metadata", async () => {
  const index = await loadAnimationIndex(
    await installed(animationFixture()),
    "avatar",
  );
  expect(index.clips.talk.duration).toBe(2);
  expect(index.activities?.speaking).toBe("talk");
});
it("rejects changed bytes, uninstalled external resources and corrupt time data", async () => {
  const clip = animationFixture();
  await expect(
    loadAnimationIndex(
      await installed({ ...clip, sha256: "0".repeat(64) }),
      "avatar",
    ),
  ).rejects.toThrow("hash mismatch");
  await expect(
    loadAnimationIndex(
      await installed(
        animationFixture([0, 2], {
          buffers: [{ uri: "https://example.invalid/file", byteLength: 40 }],
        }),
      ),
      "avatar",
    ),
  ).rejects.toThrow("External");
  await expect(
    loadAnimationIndex(await installed(animationFixture([0, NaN])), "avatar"),
  ).rejects.toThrow("finite and increasing");
});
const scene = {
  foreground: "voice",
  activeAvatar: {
    id: "avatar",
    capabilities: {
      expressions: ["happy", "sad", "angry"],
      animationCatalog: [
        {
          bodyClip: "vrma:wave",
          description: "A warm greeting",
          tags: ["greeting"],
          auto: true,
        },
        {
          bodyClip: "vrma:song",
          description: "Singing",
          tags: ["singing"],
          auto: true,
          loop: true,
        },
        { bodyClip: "vrma:diagnostic", tags: ["diagnostic"], auto: false },
      ],
    },
  },
};
function answer(input: DecisionInput): DecisionOutput {
  return {
    answers: Object.fromEntries(
      Object.entries(input.questions).map(([q, spec]) => {
        const choice = q === "emotion" ? "happy" : q === 'expressionStrength' ? 'clear' : "m0";
        return [
          q,
          {
            choice,
            probabilities: Object.fromEntries(
              Object.keys(spec.criteria).map((key) => [
                key,
                key === choice ? 1 : 0,
              ]),
            ),
          },
        ];
      }),
    ),
    model: "LAN fixture",
    usage: { input_tokens: 250, output_tokens: 20 },
  };
}
it('uses semantic expression strength rather than treating decision probability as muscle intensity',async()=>{
 const traces:Record<string,unknown>[]=[];
 for(const level of ['gentle','strong']){
  const director=new PerformanceDirector({config:()=>({enabled:true,provider:'lan',timeoutMs:1200}),
   decide:{request:async(input)=>{const result=answer(input);result.answers.emotion={choice:'happy',probabilities:{neutral:.4,happy:.6,sad:0,angry:0}};result.answers.expressionStrength={choice:level,probabilities:{gentle:level==='gentle'?1:0,clear:0,strong:level==='strong'?1:0}};return result;}},
   state:()=>scene,attach:async(args)=>{traces.push(args);return{accepted:true};},log(){}});
  await director.direct('voice','你好','speaking');
 }
 expect(traces.map(t=>t.expressionWeights)).toEqual([{happy:.35},{happy:.85}]);
});
it('releases automatic blink ownership when a face cue has decayed to zero',()=>{
 const cues=new PerformanceCues(()=>{}),audio={playing:true,actionId:'a'};
 cues.receive({eventId:'blink-cue',audioActionId:'a',expiresAt:Date.now()+10000,expressionWeights:{blinkLeft:1}});cues.update(audio,.5);
 cues.cancel('blink-cue');const automatic=cues.update(audio,3).weights;
 expect(automatic).toEqual({});
 expect(expressionWeights({available:['blink','blinkLeft'],automatic,blink:1})).toEqual({blink:1,blinkLeft:0});
});
it("offers only installed eligible clips and necessary current text, preserving speaker/quotation instructions", () => {
  const question = presentationQuestion(
    "他说‘不要挥手’。" + "长".repeat(800),
    "speaking",
    scene,
  );
  expect(question.input.state).toEqual({
    mode: "speaking",
    text: expect.any(String),
    truncated: true,
  });
  expect((question.input.state as any).text.length).toBe(500);
  expect([...question.clips.values()].map((c) => c.bodyClip)).toEqual([
    "vrma:wave",
  ]);
  expect(question.input.questions.movement.instructions).toContain(
    "quoted/negated",
  );
  expect(
    [...presentationQuestion("歌名", "singing", scene).clips.values()].map(
      (c) => c.bodyClip,
    ),
  ).toEqual(["vrma:song"]);
});

it("omits questions with no actual alternative instead of submitting invalid one-choice requests", async () => {
  const input = presentationQuestion("你好", "speaking", {
    foreground: "voice",
    activeAvatar: { id: "a", capabilities: {} },
  }).input;
  expect(input.questions).toEqual({});
  const decide = vi.fn();
  const director = new PerformanceDirector({
    config: () => ({ enabled: true, provider: "", timeoutMs: 1200 }),
    decide: { request: decide },
    state: () => ({ foreground: "voice" }),
    attach: async () => ({}),
    log() {},
  });
  await director.direct("voice", "你好", "speaking");
  expect(decide).not.toHaveBeenCalled();
  expect(director.status().last.status).toBe("no-choice");
  const faceOnly = presentationQuestion("你好", "singing", {
    foreground: "voice",
    activeAvatar: { id: "a", capabilities: { expressions: ["happy"] } },
  }).input;
  expect(Object.keys(faceOnly.questions)).toEqual(["emotion", "expressionStrength"]);
});
it('fills face and gesture independently and never overrides authored channels', async () => {
  const request = vi.fn(async (input:DecisionInput)=>answer(input));
  const attach = vi.fn(async (_args:Record<string,unknown>)=>({accepted:true}));
  const director = new PerformanceDirector({config:()=>({enabled:true,provider:'lan',timeoutMs:1200}),
    decide:{request},state:()=>scene,attach,log(){}});
  await director.direct('voice','你好！','speaking',{expression:'sad'});
  expect(Object.keys(request.mock.calls[0][0].questions)).toEqual(['movement']);
  expect(attach.mock.calls[0][0]).toMatchObject({expressionWeights:{},bodyClip:'vrma:wave'});
  expect(director.status().last).toMatchObject({presentation:{key:'vrma:wave',tags:['greeting']}});
  const both = new PerformanceDirector({config:()=>({enabled:true,provider:'lan',timeoutMs:1200}),
    decide:{request},state:()=>scene,attach,log(){}});
  await both.direct('voice','你好！','speaking',{expression:'sad',bodyClip:'vrma:wave'});
  expect(request).toHaveBeenCalledTimes(1);
  expect(both.status().last.status).toBe('no-choice');
  const body = presentationQuestion('你好','speaking',scene,[],{bodyClip:'vrma:wave'}).input;
  expect(Object.keys(body.questions)).toEqual(['emotion','expressionStrength']);
});
it("classifies once alongside the audio, attaches only to its current parent and records actual usage", async () => {
  const decide = vi.fn(async (input: DecisionInput) => answer(input)),
    attach = vi.fn(async (_args: Record<string, unknown>) => ({
      accepted: true,
      id: "cue",
    })),
    log = vi.fn();
  const director = new PerformanceDirector({
    config: () => ({ enabled: true, provider: "lan", timeoutMs: 1200 }),
    decide: { request: decide },
    state: () => scene,
    attach,
    log,
  });
  await director.direct("voice", "你好", "speaking");
  await director.direct("voice", "你好", "speaking");
  expect(decide).toHaveBeenCalledTimes(1);
  expect(decide.mock.calls[0][0].state).toMatchObject({ text: "你好" });
  expect(attach.mock.calls[0][0]).toEqual({
    action: "direct",
    audioActionId: "voice",
    expressionWeights: { happy: 0.6 },
    bodyClip: "vrma:wave",
  });
  expect(director.status().last).toMatchObject({
    status: "attached",
    usage: { input_tokens: 250 },
  });
});
it("aborts old classifications without blocking a new foreground, and never attaches late results", async () => {
  let current = { ...scene },
    release!: (value: DecisionOutput) => void,
    oldSignal!: AbortSignal;
  const attach = vi.fn(async (_args: Record<string, unknown>) => ({
    accepted: true,
  }));
  const request = vi
    .fn()
    .mockImplementationOnce((input, options) => {
      oldSignal = options.signal;
      return new Promise((resolve) => (release = resolve));
    })
    .mockImplementation((input) => Promise.resolve(answer(input)));
  const director = new PerformanceDirector({
    config: () => ({ enabled: true, provider: "lan", timeoutMs: 1200 }),
    decide: { request },
    state: () => current,
    attach,
    log() {},
  });
  const old = director.direct("voice", "旧话", "speaking");
  current = { ...scene, foreground: "new" };
  await director.direct("new", "新话", "speaking");
  expect(oldSignal.aborted).toBe(true);
  release(answer(presentationQuestion("旧话", "speaking", scene).input));
  await old;
  expect(attach).toHaveBeenCalledTimes(1);
  expect(attach.mock.calls[0][0].audioActionId).toBe("new");
  expect(director.status().inFlight).toBe(false);
});
it("leaves explicit presentation working with no optional host decision port and rejects invented choices", async () => {
  const attach = vi.fn(async () => ({}));
  const ports = {
    config: () => ({ enabled: true, provider: "", timeoutMs: 1200 }),
    state: () => scene,
    attach,
    log() {},
  };
  await new PerformanceDirector(ports).direct("voice", "你好", "speaking");
  expect(attach).not.toHaveBeenCalled();
  const director = new PerformanceDirector({
    ...ports,
    decide: {
      request: async (input) => {
        const result = answer(input);
        result.answers.movement.choice = "invented";
        return result;
      },
    },
  });
  await director.direct("voice", "你好", "speaking");
  expect(attach).not.toHaveBeenCalled();
  expect(director.status().last.status).toBe("failed");
});
it("waits for actual matching audio, respects manual body priority and cleans up only its owned gesture", () => {
  const receipt = vi.fn(),
    play = vi.fn(() => vi.fn()),
    cues = new PerformanceCues(receipt);
  cues.receive({
    eventId: "cue",
    audioActionId: "voice",
    expiresAt: Date.now() + 10000,
    expressionWeights: { happy: 0.8 },
    bodyClip: "vrma:wave",
  });
  cues.update({ playing: false }, 0.1, { play });
  expect(receipt).not.toHaveBeenCalled();
  const audio = { playing: true, actionId: "voice" };
  cues.update(audio, 0.1, { busy: true, play });
  expect(play).not.toHaveBeenCalled();
  const result = cues.update(audio, 0.1, { busy: false, play });
  expect(play).toHaveBeenCalledTimes(1);
  expect(result.weights.happy).toBeGreaterThan(0);
  expect(result.weights.happy).toBeLessThan(0.8);
  cues.cancel("cue");
  expect(play.mock.results[0].value).toHaveBeenCalledTimes(1);
  expect(cues.update(audio, 2).weights.happy ?? 0).toBeLessThan(0.01);
});
it("finishes performance with audio and follows loop activity without replaying one-shot gestures", () => {
  const receipt = vi.fn(),
    play = vi.fn(),
    cues = new PerformanceCues(receipt);
  cues.receive({
    eventId: "song-cue",
    audioActionId: "song",
    expiresAt: Date.now() + 10000,
    bodyClip: "vrma:song",
  });
  expect(
    cues.update({ playing: true, actionId: "song" }, 0.1, {
      isLoop: () => true,
      play,
    }).loopClip,
  ).toBe("vrma:song");
  expect(play).not.toHaveBeenCalled();
  expect(cues.update({ playing: false }, 0.1).loopClip).toBeUndefined();
  expect(receipt).toHaveBeenCalledWith("ended", "song-cue");
});
it("lets manual expression own the face while automatic emotion keeps mouth and blinks independent", () => {
  const input = {
    available: ["happy", "sad", "aa", "blink"],
    automatic: { happy: 0.6 },
    strength: 0.7,
    mouth: 0.4,
    blink: 0.2,
    singing: true,
    speechPlaying: false,
  };
  expect(expressionWeights(input)).toEqual({
    happy: 0.6,
    sad: 0,
    aa: 0.4,
    blink: 0.2,
  });
  expect(expressionWeights({ ...input, expression: "sad" })).toEqual({
    happy: 0,
    sad: 0.7,
    aa: 0.4,
    blink: 0.2,
  });
});
