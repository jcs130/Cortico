param([Parameter(Mandatory=$true)][string]$OutputFile)
$ErrorActionPreference='Stop'
$appOutput=[IO.Path]::GetFullPath($OutputFile)
New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($appOutput)) -Force | Out-Null
$appCompiler='C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe'
& $appCompiler /nologo /target:winexe /platform:x64 /optimize+ /out:$appOutput /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:System.Web.Extensions.dll /r:System.Net.Http.dll /r:Microsoft.CSharp.dll /r:System.Management.dll (Join-Path $PSScriptRoot 'CormyLive.cs') (Join-Path $PSScriptRoot 'StudioWindow.cs') (Join-Path $PSScriptRoot 'StandaloneObserver.cs')
if($LASTEXITCODE -ne 0){throw 'Desktop app compilation failed'}
Write-Output $appOutput
