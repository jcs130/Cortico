/** Background device for the existing desktop media page; the stage owns synthesis and audio routing. */
const path = require('node:path');
function options(argv) {
  const value = name => argv.find(arg=>arg.startsWith(name+'='))?.slice(name.length+1);
  const text=value('--pet-url');
  if(!text)throw Error('An explicit desktop pet URL is required');
  const url=new URL(text);
  if(url.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.username||url.password||url.pathname!=='/pet')
    throw Error('Expected the existing loopback desktop pet page');
  const raw=value('--parent-pid'),parentPid=raw===undefined?0:Number(raw);
  if(!Number.isSafeInteger(parentPid)||parentPid<0)throw Error('Invalid parent process');
  return {url:url.href,parentPid};
}
function run(argv) {
  const {app,BrowserWindow}=require('electron'),config=options(argv);
  app.setPath('userData',path.join(__dirname,'audio-player-profile'));
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('autoplay-policy','no-user-gesture-required');
  let win;
  app.whenReady().then(async()=>{
    const {readDependency,startDependency}=require('./audio-dependency.cjs');
    const dependency=readDependency();
    if(dependency){
      const state=await startDependency(dependency);
      console.info('[audio-host] Speech floor dependency '+(state.ready?'ready':'not ready; guardian will retry'));
    }
    win=new BrowserWindow({width:320,height:240,show:false,skipTaskbar:true,webPreferences:{backgroundThrottling:false,autoplayPolicy:'no-user-gesture-required',contextIsolation:true,sandbox:true}});
    win.webContents.on('render-process-gone',(_event,detail)=>console.error('[audio-host] Renderer exited: '+detail.reason));
    win.webContents.on('did-fail-load',(_event,code)=>console.error('[audio-host] Page load failed: '+code));
    await win.loadURL(config.url);
    console.info('[audio-host] Existing desktop media page loaded');
  }).catch(error=>{console.error('[audio-host] Startup failed: '+String(error));app.quit();});
  app.on('window-all-closed',()=>app.quit());
  if(config.parentPid)setInterval(()=>{try{process.kill(config.parentPid,0)}catch{app.quit()}},2000).unref();
}
module.exports={options};
if(process.versions.electron)run(process.argv.slice(2));
