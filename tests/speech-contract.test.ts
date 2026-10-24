import { expect, it } from "vitest";
import { VoiceService } from "../src/core/voice.ts";
import { AvatarStageServer } from "../src/server.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error Framework-free browser module.
import { expressionWeights } from "../web/expression-weights.js";

it("advertises the selected writing contract without leaking backend credentials", () => {
  const config = {url:"http://127.0.0.1:1234/speech",model:"custom",voice:"actor",
    tokenEnv:"PRIVATE_KEY",instructions:"private instruction",textFormat:"drama-3" as const};
  const service = new VoiceService(() => config, ".", () => {});
  expect(service.status()).toMatchObject({textFormat:"drama-3"});
  expect(service.status().writingGuide).toContain("square-bracket");
  expect(JSON.stringify(service.status())).not.toContain("PRIVATE_KEY");
  expect(JSON.stringify(service.status())).not.toContain("private instruction");
  delete (config as Partial<typeof config>).textFormat;
  expect(service.status().textFormat).toBe("plain");
});
it("preserves explicit standard VRM visemes until real speech owns the mouth", () => {
  const state = { available:["aa","happy","blink","blinkLeft","blinkRight"],expression:"aa",
    strength:.7,singing:false,speechPlaying:false,mouth:0,blink:.8 };
  expect(expressionWeights(state).aa).toBe(.7);
  expect(expressionWeights({...state,speechPlaying:true,mouth:.3}).aa).toBe(.3);
});
it("does not reset or double a directed blink with automatic blinking", () => {
  const state = { available:["blink","blinkLeft","blinkRight"],expression:"blinkLeft",
    strength:1,singing:false,speechPlaying:false,mouth:0,blink:1 };
  expect(expressionWeights(state)).toEqual({blink:0,blinkLeft:1,blinkRight:0});
  expect(expressionWeights({...state,expression:"blink",blink:0}).blink).toBe(1);
  expect(expressionWeights({...state,expression:null}).blink).toBe(1);
});
it("serves the facial mixer imported by the public browser entry", async () => {
  const dataDir=await mkdtemp(join(tmpdir(),'vrm-face-module-'));
  const server=new AvatarStageServer({port:0,dataDir,avatars:[]});
  try {
    await server.start();
    const entry=await fetch(server.url+'/viewer.js');
    expect(entry.ok).toBe(true);
    // The distribution bundles the facial mixer and standard VRMA loader, so
    // new browser helpers cannot fail on the server's static-file allow list.
    const script = await entry.text();
    expect(script.includes('function expressionWeights')).toBe(true);
    expect(script.includes('VRMMotionLayer')).toBe(true);
    expect(script.includes('from "@pixiv/three-vrm-animation"')).toBe(false);
    const module=await fetch(server.url+'/expression-weights.js');
    expect(module.ok).toBe(true);
    expect(module.headers.get('content-type')).toContain('javascript');
    expect(await module.text()).toContain('export function expressionWeights');
  } finally {await server.stop();await rm(dataDir,{recursive:true,force:true});}
});
