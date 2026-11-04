import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {options}=createRequire(import.meta.url)('./audio-host.cjs');
test('keeps the loopback pet identity fragment and the owning host process',()=>{
  assert.deepEqual(options(['--pet-url=http://127.0.0.1:18446/pet#key=fixture','--parent-pid=123']),{url:'http://127.0.0.1:18446/pet#key=fixture',parentPid:123});
});
test('refuses external pages, URL credentials and invalid host lifetimes',()=>{
  for(const url of ['https://example.invalid/pet','http://127.0.0.1:18446/settings','http://user:pass@127.0.0.1:18446/pet'])assert.throws(()=>options(['--pet-url='+url]));
  for(const pid of ['-1','NaN','1.5'])assert.throws(()=>options(['--pet-url=http://localhost:18446/pet','--parent-pid='+pid]));
  assert.throws(()=>options([]));
});
