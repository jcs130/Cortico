param([string]$ServiceDir='I:/CormyLive/services/drama3-20261021')
$ErrorActionPreference='Stop'
try { $voiceHealth=Invoke-RestMethod -Uri 'http://127.0.0.1:18517/health' -TimeoutSec 2; if($voiceHealth.model -eq 'cormy-drama3'){exit 0} } catch {}
$voiceNode='I:/CormyLive/runtime/node.exe'
$voiceProcess=Start-Process -FilePath $voiceNode -ArgumentList @(('"'+$ServiceDir+'/bridge.mjs"'),('"'+$ServiceDir+'/config.json"')) -WorkingDirectory $ServiceDir -WindowStyle Hidden -RedirectStandardOutput ($ServiceDir+'/bridge.stdout.log') -RedirectStandardError ($ServiceDir+'/bridge.stderr.log') -PassThru
$voiceProcess.WaitForExit()
exit $voiceProcess.ExitCode
