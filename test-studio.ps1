param([string]$OutputDir=(Join-Path ([IO.Path]::GetTempPath()) ('cormy-studio-test-'+[Guid]::NewGuid().ToString('N'))))
$ErrorActionPreference='Stop'
$studioTestRoot=[IO.Path]::GetFullPath($OutputDir)
$studioTestApp=Join-Path $studioTestRoot 'CormyLive.exe'
& (Join-Path $PSScriptRoot 'build.ps1') -OutputFile $studioTestApp | Out-Null
$studioTestExe=Join-Path $studioTestRoot 'test-studio.exe'
& 'C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe' /nologo /target:exe ('/out:'+$studioTestExe) ('/r:'+$studioTestApp) (Join-Path $PSScriptRoot 'test-studio.cs')
if($LASTEXITCODE -ne 0){throw 'Studio contract tests did not compile'}
& $studioTestExe
if($LASTEXITCODE -ne 0){throw 'Studio contract tests failed'}
$studioObserverTest=Join-Path $studioTestRoot 'test-standalone.exe'
& 'C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe' /nologo /target:exe ('/out:'+$studioObserverTest) ('/r:'+$studioTestApp) (Join-Path $PSScriptRoot 'test-standalone.cs')
if($LASTEXITCODE -ne 0){throw 'Standalone observer tests did not compile'}
& $studioObserverTest
if($LASTEXITCODE -ne 0){throw 'Standalone observer tests failed'}
