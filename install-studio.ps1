param(
 [string]$InstallDir='I:/CormyLive',
 [Parameter(Mandatory=$true)][string]$AvatarExecutable,
 [Parameter(Mandatory=$true)][string]$AvatarApp,
 [string]$AvatarUrl='http://127.0.0.1:18431/?obs=1',
 [switch]$SkipShortcuts
)
$ErrorActionPreference='Stop'
$studioRoot=[IO.Path]::GetFullPath($InstallDir)
$studioHostConfig=Join-Path $studioRoot 'settings.json'
$studioHost=Get-Content -LiteralPath $studioHostConfig -Raw | ConvertFrom-Json
$studioOriginalHash=(Get-FileHash -LiteralPath $studioHostConfig).Hash
$studioTaskName=$studioHost.TaskName+'.Studio'
$studioDescription='Cormy Live studio panel; display controls only, manual start, closing keeps the host running.'
$studioOldTask=Get-ScheduledTask -TaskName $studioTaskName -ErrorAction SilentlyContinue
if($studioOldTask -and $studioOldTask.Description -ne $studioDescription){throw 'Existing task has another owner'}
if($studioOldTask -and $studioOldTask.Triggers){throw 'Expected a manual task'}
if(-not(Test-Path -LiteralPath $AvatarExecutable -PathType Leaf)){throw 'Installed Electron not found'}
if(-not(Test-Path -LiteralPath (Join-Path $AvatarApp 'package.json') -PathType Leaf)){throw 'Installed transparent renderer not found'}
$studioVersion=Join-Path $studioRoot ('studio/'+(Get-Date -Format 'yyyyMMdd-HHmmss'))
$studioExe=Join-Path $studioVersion 'CormyLive.exe'
& (Join-Path $PSScriptRoot 'build.ps1') -OutputFile $studioExe | Out-Null
$studioSettings=Join-Path $studioVersion 'studio.json'
@{AvatarExecutable=[IO.Path]::GetFullPath($AvatarExecutable);AvatarApp=[IO.Path]::GetFullPath($AvatarApp);AvatarStatusFile=Join-Path ([IO.Path]::GetFullPath($AvatarApp)) 'runtime/status.json';AvatarUrl=$AvatarUrl;StateFile=Join-Path $studioRoot 'studio-window.json'} | ConvertTo-Json | Set-Content -LiteralPath $studioSettings -Encoding utf8
if($studioOldTask){Export-ScheduledTask -TaskName $studioTaskName | Set-Content -LiteralPath (Join-Path $studioVersion 'task-before.xml') -Encoding utf8}
$studioUser=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$studioPrincipal=New-ScheduledTaskPrincipal -UserId $studioUser -LogonType Interactive -RunLevel Limited
# A second invocation focuses the first via the application's mutex/window identity.
$studioPolicy=New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances Parallel -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -Priority 6
$studioAction=New-ScheduledTaskAction -Execute $studioExe -Argument ('--studio --config "'+$studioHostConfig+'" --studio-config "'+$studioSettings+'"') -WorkingDirectory $studioRoot
$studioTask=New-ScheduledTask -Action $studioAction -Principal $studioPrincipal -Settings $studioPolicy -Description $studioDescription
Register-ScheduledTask -TaskName $studioTaskName -InputObject $studioTask -Force | Out-Null
if(-not $SkipShortcuts){
 $studioShell=New-Object -ComObject WScript.Shell
 foreach($studioFolder in @([Environment]::GetFolderPath('Desktop'),(Join-Path ([Environment]::GetFolderPath('Programs')) '可米直播'))){
  New-Item -ItemType Directory -Path $studioFolder -Force | Out-Null
  $studioLink=$studioShell.CreateShortcut((Join-Path $studioFolder '可米直播小助手.lnk'))
  $studioLink.TargetPath=$studioExe;$studioLink.Arguments='--studio-open --config "'+$studioHostConfig+'"';$studioLink.WorkingDirectory=$studioRoot
  $studioLink.Description='观战与透明形象的独立小窗口；关闭后直播继续'
  $studioIcon=Join-Path $studioRoot 'CormyLive.ico';if(Test-Path -LiteralPath $studioIcon){$studioLink.IconLocation=$studioIcon}
  $studioLink.Save()
 }
}
if((Get-FileHash -LiteralPath $studioHostConfig).Hash -ne $studioOriginalHash){throw 'Host settings changed unexpectedly'}
@{at=(Get-Date -Format o);task=$studioTaskName;exe=$studioExe;settings=$studioSettings;manual=$true;hostReloaded=$false;hostSettingsChanged=$false} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $studioRoot 'studio-active.json') -Encoding utf8
Get-Content -LiteralPath (Join-Path $studioRoot 'studio-active.json')
