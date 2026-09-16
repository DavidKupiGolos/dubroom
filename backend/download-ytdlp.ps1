param(
  [string]$DownloadUrl = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe"
)

$ErrorActionPreference = "Stop"
$toolsDir = Join-Path $PSScriptRoot "tools"
$target = Join-Path $toolsDir "yt-dlp.exe"
New-Item -ItemType Directory -Path $toolsDir -Force | Out-Null
Invoke-WebRequest -Uri $DownloadUrl -OutFile $target
Write-Host "yt-dlp is ready at backend\tools\yt-dlp.exe"
