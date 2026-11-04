param([string]$OutputDir='D:/workspace/ai主播/scratch/heartbeat-20261016-1034/launcher-test')
$ErrorActionPreference='Stop'
$appTestRoot=[IO.Path]::GetFullPath($OutputDir)
New-Item -ItemType Directory -Path $appTestRoot -Force | Out-Null
$appTestPort=18429
if(Get-NetTCPConnection -LocalPort $appTestPort -State Listen -ErrorAction SilentlyContinue) { throw 'Test port is occupied' }
$appTestName='Cormy.Live.LifecycleTest'
if(Get-ScheduledTask -TaskName $appTestName -ErrorAction SilentlyContinue) { throw 'A previous lifecycle test task exists' }
@'
const http = require('http');
let paused = false;
const server = http.createServer((req,res) => {
  res.setHeader('content-type','application/json');
  if(req.url==='/api/status') return res.end(JSON.stringify({loop:{running:true,paused},fixture:true,pid:process.pid}));
  if(req.url==='/api/run/pause') paused=true;
  if(req.url==='/api/run/resume') paused=false;
  res.end(JSON.stringify({ok:true,localComplete:true}));
  if(req.url==='/api/run/shutdown') server.close(()=>process.exit(0));
});
server.listen(18429,'127.0.0.1');
'@ | Set-Content -LiteralPath (Join-Path $appTestRoot 'fixture.cjs') -Encoding utf8
$appTestCfg=@{Title='可米启动器测试';TaskName=$appTestName;Root=$appTestRoot;Node='C:/Program Files/nodejs/node.exe';Entry='fixture.cjs';Deployment='fixture';ConsoleUrl="http://127.0.0.1:$appTestPort";ViewerUrl="http://127.0.0.1:$appTestPort";DataDir=(Join-Path $appTestRoot 'logs');StartPaused=$false}
$appTestCfg | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $appTestRoot 'fixture-settings.json') -Encoding utf8
& (Join-Path $PSScriptRoot 'install.ps1') -InstallDir (Join-Path $appTestRoot 'app') -TaskName $appTestName -SettingsFile (Join-Path $appTestRoot 'fixture-settings.json') -SkipShortcuts
if($LASTEXITCODE -ne 0) { throw 'Test app installation failed' }
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class LauncherJobTest {
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] public struct Startup { public int cb; public string reserved,desktop,title; public int x,y,xSize,ySize,xCount,yCount,fill,flags; public short show,cbReserved; public IntPtr reserved2,stdin,stdout,stderr; }
 [StructLayout(LayoutKind.Sequential)] public struct ProcessInfo { public IntPtr process,thread; public int pid,tid; }
 [StructLayout(LayoutKind.Sequential)] public struct Limits { public long processTime,jobTime; public uint flags; public UIntPtr min,max; public uint active; public UIntPtr affinity; public uint priority,scheduling; }
 [StructLayout(LayoutKind.Sequential)] public struct Io { public ulong r,w,o,rb,wb,ob; }
 [StructLayout(LayoutKind.Sequential)] public struct Extended { public Limits limits; public Io io; public UIntPtr processMemory,jobMemory,peakProcessMemory,peakJobMemory; }
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] public static extern IntPtr CreateJobObject(IntPtr a,string name);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool SetInformationJobObject(IntPtr job,int cls,ref Extended info,uint size);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] public static extern bool CreateProcess(string app,string command,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref Startup si,out ProcessInfo pi);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
 [DllImport("kernel32.dll")] public static extern uint ResumeThread(IntPtr thread);
 [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
 [DllImport("kernel32.dll")] public static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool IsProcessInJob(IntPtr process,IntPtr job,out bool result);
 public static void Check(bool ok) { if(!ok) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()); }
}
'@
$appTestJob=[LauncherJobTest]::CreateJobObject([IntPtr]::Zero,'CormyLaunchLifecycleTest')
$appTestLimit=New-Object LauncherJobTest+Extended
$appTestBasic=New-Object LauncherJobTest+Limits
$appTestBasic.flags=0x2000
$appTestLimit.limits=$appTestBasic
if($appTestLimit.limits.flags -ne 0x2000) { throw 'Kill-on-close test flag was not set' }
[LauncherJobTest]::Check([LauncherJobTest]::SetInformationJobObject($appTestJob,9,[ref]$appTestLimit,[Runtime.InteropServices.Marshal]::SizeOf($appTestLimit)))
$appTestExe=Join-Path $appTestRoot 'app/CormyLive.exe'
$appTestPowerShell="$env:SystemRoot/System32/WindowsPowerShell/v1.0/powershell.exe"
$appTestStarter=Join-Path $appTestRoot 'start.ps1'
[IO.File]::WriteAllText($appTestStarter,"& '$appTestExe' --start`nStart-Sleep -Seconds 45",[Text.UTF8Encoding]::new($true))
$appTestSi=New-Object LauncherJobTest+Startup
$appTestSi.cb=[Runtime.InteropServices.Marshal]::SizeOf($appTestSi)
$appTestPi=New-Object LauncherJobTest+ProcessInfo
$appTestCommand='"'+$appTestPowerShell+'" -NoProfile -WindowStyle Hidden -File "'+$appTestStarter+'"'
try {
 [LauncherJobTest]::Check([LauncherJobTest]::CreateProcess($appTestPowerShell,$appTestCommand,[IntPtr]::Zero,[IntPtr]::Zero,$false,0x08000004,[IntPtr]::Zero,$appTestRoot,[ref]$appTestSi,[ref]$appTestPi))
 [LauncherJobTest]::Check([LauncherJobTest]::AssignProcessToJobObject($appTestJob,$appTestPi.process))
 [LauncherJobTest]::ResumeThread($appTestPi.thread) | Out-Null
 $appTestAlive=$null
 for($appTestAttempt=0;$appTestAttempt -lt 25;$appTestAttempt++) {
   try { $appTestAlive=Invoke-RestMethod -Uri "http://127.0.0.1:$appTestPort/api/status" -TimeoutSec 1; break } catch { Start-Sleep -Milliseconds 500 }
 }
 if(-not $appTestAlive.fixture) { throw 'Fixture did not start' }
 $appTestState=Get-Content -LiteralPath (Join-Path $appTestRoot 'logs/worker.json') -Raw | ConvertFrom-Json
 $appTestWorker=Get-Process -Id $appTestState.workerPid
 $appTestInJob=$false
 [LauncherJobTest]::Check([LauncherJobTest]::IsProcessInJob($appTestWorker.Handle,$appTestJob,[ref]$appTestInJob))
 if($appTestInJob) { throw 'Worker inherited caller job' }
 [LauncherJobTest]::CloseHandle($appTestJob) | Out-Null
 $appTestJob=[IntPtr]::Zero
 Start-Sleep -Milliseconds 700
 $appTestAfter=Invoke-RestMethod -Uri "http://127.0.0.1:$appTestPort/api/status" -TimeoutSec 2
 if($appTestAfter.pid -ne $appTestAlive.pid) { throw 'Fixture identity changed' }
 if([LauncherJobTest]::WaitForSingleObject($appTestPi.process,3000) -ne 0) { throw 'Kill-on-close launcher did not exit' }
 Start-Process -FilePath $appTestExe -ArgumentList '--start' -WindowStyle Hidden -Wait
 Start-Sleep -Milliseconds 300
 $appTestDuplicate=Invoke-RestMethod -Uri "http://127.0.0.1:$appTestPort/api/status" -TimeoutSec 2
 if($appTestDuplicate.pid -ne $appTestAlive.pid) { throw 'Duplicate host launched' }
 Invoke-RestMethod -Uri "http://127.0.0.1:$appTestPort/api/run/shutdown" -Method Post -ContentType 'application/json' -Body '{}' -TimeoutSec 5 | Out-Null
 for($appTestAttempt=0;$appTestAttempt -lt 15;$appTestAttempt++) {
   $appTestFinal=Get-Content -LiteralPath (Join-Path $appTestRoot 'logs/worker.json') -Raw | ConvertFrom-Json
   if($appTestFinal.state -eq 'exited') { break }
   Start-Sleep -Milliseconds 300
 }
 if($appTestFinal.state -ne 'exited' -or $appTestFinal.exitCode -ne 0) { throw 'Graceful shutdown not confirmed' }
 @{at=(Get-Date -Format o);fakeHost=$true;launcherKilled=$true;workerOutsideCallerJob=$true;samePidSurvived=$true;duplicateStartSingleHost=$true;gracefulShutdown=$true;actualCodexClosed=$false} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $appTestRoot 'validation.json') -Encoding utf8
 Get-Content -LiteralPath (Join-Path $appTestRoot 'validation.json')
} finally {
 if($appTestJob -ne [IntPtr]::Zero) { [LauncherJobTest]::CloseHandle($appTestJob) | Out-Null }
 if($appTestPi.thread -ne [IntPtr]::Zero) { [LauncherJobTest]::CloseHandle($appTestPi.thread) | Out-Null }
 if($appTestPi.process -ne [IntPtr]::Zero) { [LauncherJobTest]::CloseHandle($appTestPi.process) | Out-Null }
 try {
   $appTestRemaining=Invoke-RestMethod -Uri "http://127.0.0.1:$appTestPort/api/status" -TimeoutSec 1
   if($appTestRemaining.fixture) { Invoke-RestMethod -Uri "http://127.0.0.1:$appTestPort/api/run/shutdown" -Method Post -ContentType 'application/json' -Body '{}' -TimeoutSec 3 | Out-Null; Start-Sleep -Milliseconds 500 }
 } catch { }
 foreach($appTestTaskName in @($appTestName,($appTestName+'.Panel'))) {
   $appTestTask=Get-ScheduledTask -TaskName $appTestTaskName -ErrorAction SilentlyContinue
   if($appTestTask -and $appTestTask.State -ne 'Running') { Unregister-ScheduledTask -TaskName $appTestTaskName -Confirm:$false }
 }
}
