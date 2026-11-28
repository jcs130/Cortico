import {readFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {isAbsolute,join} from 'node:path';

const exec=promisify(execFile);
async function ready(url){
  try{const r=await fetch(url,{signal:AbortSignal.timeout(1000),redirect:'error'});return r.ok && (await r.json()).status==='ok';}
  catch{return false;}
}
// The deployment owns credentials; an OS task starts only an explicitly selected loopback dependency.
export async function ensureLocalRecognizer(config,{health=ready,startTask,wait=ms=>new Promise(r=>setTimeout(r,ms))}={}){
  if(!config || !isAbsolute(config.deploymentConfig??'') || !/^[A-Za-z0-9_.-]+$/.test(config.task??''))throw Error('Invalid local recognizer configuration');
  const url=new URL(config.endpoint);
  if(url.protocol!=='http:' || url.hostname!=='127.0.0.1' || url.username || url.password || url.pathname!=='/inference' || url.search || url.hash)throw Error('Invalid local recognizer endpoint');
  const setup=JSON.parse(await readFile(config.deploymentConfig,'utf8'));
  const game=setup.worlds?.[config.world],voice=game?.servers?.[game.server]?.simpleVoiceChat;
  if(!voice?.enabled || voice.transcriptionEndpoint!==url.href)return 'unused';
  const check=()=>health(new URL('/health',url).href);
  if(await check())return 'ready';
  const start=startTask??(name=>exec(join(process.env.SystemRoot,'System32','schtasks.exe'),['/Run','/TN',name],
    {windowsHide:true,timeout:5000,env:{SystemRoot:process.env.SystemRoot,windir:process.env.SystemRoot}}));
  await start(config.task);
  for(let i=0;i<20;i++){await wait(500);if(await check())return 'ready';}
  throw Error('Local recognizer health unconfirmed');
}

