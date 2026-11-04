param([string]$Settings = 'I:/CormyLive/settings.json')
$ErrorActionPreference = 'Stop'
$cfg = Get-Content -LiteralPath $Settings -Raw | ConvertFrom-Json
$base = $cfg.ConsoleUrl.TrimEnd('/')
$route = $base + '/api/webui/providers/world%3Adesktop-pet/panels/pet/'
try { $state = Invoke-RestMethod -Uri ($route + 'state') -TimeoutSec 3 }
catch {
    Start-ScheduledTask -TaskName $cfg.TaskName
    $state = $null
    for ($attempt = 0; $attempt -lt 45; $attempt++) {
        Start-Sleep -Seconds 2
        try { $state = Invoke-RestMethod -Uri ($route + 'state') -TimeoutSec 3; break } catch { }
    }
    if ($null -eq $state) { throw '可米桌宠尚未就绪，请查看可米直播控制台。' }
}
if ($state.connected -and $state.onDesktop) { return }
if ($state.connected -and -not $state.onDesktop) {
    $null = Invoke-RestMethod -Uri ($route + 'closeWindow') -Method Post -ContentType 'application/json' -Body '{"args":[]}' -TimeoutSec 10
}
$null = Invoke-RestMethod -Uri ($route + 'openWindow') -Method Post -ContentType 'application/json' -Body '{"args":[]}' -TimeoutSec 10
