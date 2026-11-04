param([string]$InstallDir='I:/CormyLive')
$ErrorActionPreference='Stop'
$appRoot=[IO.Path]::GetFullPath($InstallDir)
$appSettings=Join-Path $appRoot 'settings.json'
$appConfig=Get-Content -LiteralPath $appSettings -Raw | ConvertFrom-Json
$appConfigBytes=[IO.File]::ReadAllBytes($appSettings)
$appVersion=Get-Date -Format 'yyyyMMdd-HHmmss'
$appExe=Join-Path $appRoot ('versions/'+$appVersion+'/CormyLive.exe')
$appDescription='Cormy Live desktop launcher; manual start only. Closing the panel does not stop the host.'
$appTasks=@($appConfig.TaskName,($appConfig.TaskName+'.Panel'))
foreach($appTaskName in $appTasks){
 $appTask=Get-ScheduledTask -TaskName $appTaskName
 if($appTask.Description -ne $appDescription){throw ('Task has a different owner: '+$appTaskName)}
 if($appTask.Triggers){throw 'Expected manual tasks without triggers'}
}
& (Join-Path $PSScriptRoot 'build.ps1') -OutputFile $appExe | Out-Null
$appPrior=@()
foreach($appTaskName in $appTasks){
 $appPrior+=@{name=$appTaskName;xml=(Export-ScheduledTask -TaskName $appTaskName)}
}
$appUpdateDir=Join-Path $appRoot ('versions/'+$appVersion)
$appPrior | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $appUpdateDir 'tasks-before.json') -Encoding utf8
try{
 foreach($appKind in @(@{Name=$appConfig.TaskName;Argument='--worker'},@{Name=($appConfig.TaskName+'.Panel');Argument='--ui'})){
  $appAction=New-ScheduledTaskAction -Execute $appExe -Argument ($appKind.Argument+' --config "'+$appSettings+'"') -WorkingDirectory $appRoot
  Set-ScheduledTask -TaskName $appKind.Name -Action $appAction | Out-Null
 }
 if([Convert]::ToBase64String($appConfigBytes) -ne [Convert]::ToBase64String([IO.File]::ReadAllBytes($appSettings))){throw 'Launcher settings changed'}
}catch{
 foreach($appTask in $appPrior){Register-ScheduledTask -TaskName $appTask.name -Xml $appTask.xml -Force | Out-Null}
 throw
}
$appRecord=@{at=(Get-Date -Format o);entry=Join-Path $appRoot 'CormyLive.exe';activeExecutable=$appExe;taskActionsUpdated=$true;runningWorkerStopped=$false;settingsChanged=$false;rollback=Join-Path $appUpdateDir 'tasks-before.json'}
$appRecord | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $appRoot 'active-version.json') -Encoding utf8
$appRecord | ConvertTo-Json -Depth 4
