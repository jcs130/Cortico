import {test} from 'node:test';
import assert from 'node:assert/strict';
import {nativeSessionOptions} from './session-options.mjs';
test('preserves the established memory policy by default',()=>{
  assert.deepEqual(nativeSessionOptions({}),{'fish_drama3.cpu_expert_layers':4,'fish_drama3.context_length':2048});
});
test('uses only explicit native disk cache options without changing weights',()=>{
  assert.deepEqual(nativeSessionOptions({cpuExpertLayers:0,diskExperts:true,expertCacheSize:8,pinExperts:true}),{
    'fish_drama3.cpu_expert_layers':0,'fish_drama3.context_length':2048,'fish_drama3.disk_experts':true,
    'fish_drama3.expert_cache_size':8,'fish_drama3.pin_experts':true,
  });
});
test('rejects malformed memory policies before spawning native inference',()=>{
  for(const config of [{diskExperts:'true'},{diskExperts:true,expertCacheSize:7},{diskExperts:true,expertCacheSize:257},{pinExperts:true},{cpuExpertLayers:-1}])
    assert.throws(()=>nativeSessionOptions(config));
});
