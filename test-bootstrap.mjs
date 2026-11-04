import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, dirname, basename } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const bootstrap = fileURLToPath(new URL('./bootstrap.mjs', import.meta.url));
function rig() {
  const dir = mkdtempSync(join(tmpdir(), 'cormy-bootstrap-'));
  const entry = join(dir, 'entry.mjs'), envFile = join(dir, 'private.env'), config = join(dir, 'bootstrap.json');
  writeFileSync(envFile, 'BOOTSTRAP_ALLOWED=fixture-value\nBOOTSTRAP_OTHER=excluded-value\n');
  writeFileSync(entry, `import {writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
writeFileSync(${JSON.stringify(join(dir,'result.json'))},JSON.stringify({
allowed:process.env.BOOTSTRAP_ALLOWED==='fixture-value',other:process.env.BOOTSTRAP_OTHER??null,
mainGuard:process.argv[1]===fileURLToPath(import.meta.url),args:process.argv.slice(2),
childInherited:execFileSync(process.execPath,['-p',"process.env.BOOTSTRAP_ALLOWED==='fixture-value'"],{encoding:'utf8'}).trim()==='true'}));`);
  writeFileSync(config, JSON.stringify({ entry, envFile, environmentKeys: ['BOOTSTRAP_ALLOWED'] }));
  const env = { ...process.env }; delete env.BOOTSTRAP_ALLOWED; delete env.BOOTSTRAP_OTHER;
  return { dir, entry, envFile, config, env, cleanup: () => {
    if (dirname(resolve(dir))!==resolve(tmpdir()) || !basename(dir).startsWith('cormy-bootstrap-')) throw Error('Invalid cleanup target');
    rmSync(dir, {recursive:true,force:true});
  } };
}
test('loads only configured variables, preserves the main guard and forwards arguments', () => {
  const r=rig();
  try {
    execFileSync(process.execPath,[bootstrap,'--bootstrap-config',r.config,'--bot','fixture'],{env:r.env});
    assert.deepEqual(JSON.parse(readFileSync(join(r.dir,'result.json'),'utf8')),
      {allowed:true,other:null,mainGuard:true,args:['--bot','fixture'],childInherited:true});
  } finally { r.cleanup(); }
});
test('rejects a missing credential without printing any environment value', () => {
  const r=rig();
  try {
    writeFileSync(r.envFile,'BOOTSTRAP_OTHER=excluded-value\n');
    const result=spawnSync(process.execPath,[bootstrap,'--bootstrap-config',r.config],{env:r.env,encoding:'utf8'});
    assert.notEqual(result.status,0); assert.match(result.stderr,/Configured credential variable is missing/);
    assert.ok(!result.stderr.includes('excluded-value'));
  } finally { r.cleanup(); }
});
