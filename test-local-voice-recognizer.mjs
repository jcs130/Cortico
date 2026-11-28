import {test} from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {ensureLocalRecognizer} from './local-voice-recognizer.mjs';
test('checks the selected profile and starts only an unavailable local service',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'cormy-asr-')),deploymentConfig=join(dir,'config.json'),endpoint='http://127.0.0.1:8790/inference';
 try{
  const conf={deploymentConfig,endpoint,task:'WhisperSTT-Server',world:'mymc'};
  const save=server=>writeFile(deploymentConfig,JSON.stringify({worlds:{mymc:{server,servers:{tig:{simpleVoiceChat:{enabled:true,transcriptionEndpoint:endpoint}},other:{}}}}}));
  let live=false,calls=0;const deps={health:async()=>live,startTask:async name=>{assert.equal(name,conf.task);calls++;live=true;},wait:async()=>{}};
  await save('other');assert.equal(await ensureLocalRecognizer(conf,deps),'unused');assert.equal(calls,0);
  await save('tig');assert.equal(await ensureLocalRecognizer(conf,deps),'ready');assert.equal(calls,1);
  assert.equal(await ensureLocalRecognizer(conf,deps),'ready');assert.equal(calls,1);
  await assert.rejects(ensureLocalRecognizer({...conf,endpoint:'http://example.com/inference'},deps));
 }finally{await rm(dir,{recursive:true,force:true});}
});
