param(
  [string]$InstallDir = 'I:/CormyLive',
  [string]$CorticoRoot = 'I:/Cortico',
  [string]$TaskName = 'Cormy.Live',
  [string]$SettingsFile,
  [string]$NodeSource,
  [switch]$SkipShortcuts
)
$ErrorActionPreference = 'Stop'
$appInstallDir = [System.IO.Path]::GetFullPath($InstallDir)
New-Item -ItemType Directory -Path $appInstallDir -Force | Out-Null
$appExe = Join-Path $appInstallDir 'CormyLive.exe'
& (Join-Path $PSScriptRoot 'build.ps1') -OutputFile $appExe | Out-Null
if ($SettingsFile) {
  Copy-Item -LiteralPath $SettingsFile -Destination (Join-Path $appInstallDir 'settings.json')
} elseif (-not (Test-Path -LiteralPath (Join-Path $appInstallDir 'settings.json'))) {
  $appConfig = @{Title='可米直播';TaskName=$TaskName;Root=$CorticoRoot;Node='C:/Program Files/nodejs/node.exe';Entry='bin/cortico.mjs';Deployment='cortiv';ConsoleUrl='http://127.0.0.1:7789';ViewerUrl='http://127.0.0.1:7793';DataDir=(Join-Path $appInstallDir 'logs');StartPaused=$true}
  $appConfig | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $appInstallDir 'settings.json') -Encoding utf8
}
if($NodeSource) {
  $appRuntimeDir=Join-Path $appInstallDir 'runtime'
  New-Item -ItemType Directory -Path $appRuntimeDir -Force | Out-Null
  $appNode=Join-Path $appRuntimeDir 'node.exe'
  Copy-Item -LiteralPath $NodeSource -Destination $appNode
  & $appNode --input-type=module -e "import {registerHooks} from 'node:module'; if(typeof registerHooks !== 'function') process.exit(1)"
  if($LASTEXITCODE -ne 0) { throw 'Node runtime lacks the Cortico module hook API' }
  $appRuntimeConfig=Get-Content -LiteralPath (Join-Path $appInstallDir 'settings.json') -Raw | ConvertFrom-Json
  $appRuntimeConfig.Node=$appNode
  $appRuntimeConfig | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $appInstallDir 'settings.json') -Encoding utf8
}
$appIdentity=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$appPrincipal=New-ScheduledTaskPrincipal -UserId $appIdentity -LogonType Interactive -RunLevel Limited
$appSettings=New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -Priority 6
$appDescription='Cormy Live desktop launcher; manual start only. Closing the panel does not stop the host.'
foreach ($appKind in @(@{Name=$TaskName;Argument='--worker'},@{Name=($TaskName+'.Panel');Argument='--ui'})) {
  $appExisting=Get-ScheduledTask -TaskName $appKind.Name -ErrorAction SilentlyContinue
  if ($appExisting -and $appExisting.Description -ne $appDescription) { throw ('Existing task has a different owner: '+$appKind.Name) }
  if ($appExisting -and $appExisting.State -eq 'Running') { throw ('Task is running: '+$appKind.Name) }
  $appAction=New-ScheduledTaskAction -Execute $appExe -Argument $appKind.Argument -WorkingDirectory $appInstallDir
  $appTask=New-ScheduledTask -Action $appAction -Principal $appPrincipal -Settings $appSettings -Description $appDescription
  Register-ScheduledTask -TaskName $appKind.Name -InputObject $appTask -Force | Out-Null
}
if (-not $SkipShortcuts) {
  $appShell=New-Object -ComObject WScript.Shell
  foreach($appShortcutDir in @([Environment]::GetFolderPath('Desktop'),(Join-Path ([Environment]::GetFolderPath('Programs')) '可米直播'))) {
    New-Item -ItemType Directory -Path $appShortcutDir -Force | Out-Null
    $appShortcut=$appShell.CreateShortcut((Join-Path $appShortcutDir '可米直播.lnk'))
    $appShortcut.TargetPath=$appExe
    $appShortcut.WorkingDirectory=$appInstallDir
    $appShortcut.Description='可米直播独立入口'
    $appShortcut.Save()
  }
}
$appInstalledConfig=Get-Content -LiteralPath (Join-Path $appInstallDir 'settings.json') -Raw | ConvertFrom-Json
@{installedAt=(Get-Date -Format o);directory=$appInstallDir;executable=$appExe;manualTasks=@($TaskName,($TaskName+'.Panel'));autoStart=$false;node=$appInstalledConfig.Node} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $appInstallDir 'installation.json') -Encoding utf8
Write-Output ('Installed desktop entry: '+$appExe)
