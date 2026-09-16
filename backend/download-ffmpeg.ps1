param(
  [string]$ArchiveUrl = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip"
)

$ErrorActionPreference = "Stop"
$toolsDir = Join-Path $PSScriptRoot "tools"
$tempRoot = [System.IO.Path]::GetFullPath($env:TEMP)
$archivePath = [System.IO.Path]::GetFullPath((Join-Path $tempRoot "dubroom-ffmpeg.zip"))
$extractDir = [System.IO.Path]::GetFullPath((Join-Path $tempRoot "dubroom-ffmpeg-extract"))
if (-not $extractDir.StartsWith($tempRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Unexpected temporary extraction path: $extractDir"
}

New-Item -ItemType Directory -Path $toolsDir -Force | Out-Null
if (Test-Path -LiteralPath $extractDir) {
  Remove-Item -LiteralPath $extractDir -Recurse -Force
}

Invoke-WebRequest -Uri $ArchiveUrl -OutFile $archivePath
Expand-Archive -LiteralPath $archivePath -DestinationPath $extractDir -Force
$ffmpeg = Get-ChildItem -LiteralPath $extractDir -Filter "ffmpeg.exe" -Recurse | Select-Object -First 1
$ffprobe = Get-ChildItem -LiteralPath $extractDir -Filter "ffprobe.exe" -Recurse | Select-Object -First 1
if (-not $ffmpeg) {
  throw "ffmpeg.exe was not found in the downloaded archive."
}
if (-not $ffprobe) {
  throw "ffprobe.exe was not found in the downloaded archive."
}

Copy-Item -LiteralPath $ffmpeg.FullName -Destination (Join-Path $toolsDir "ffmpeg.exe") -Force
Copy-Item -LiteralPath $ffprobe.FullName -Destination (Join-Path $toolsDir "ffprobe.exe") -Force
Remove-Item -LiteralPath $archivePath -Force
Remove-Item -LiteralPath $extractDir -Recurse -Force
Write-Host "FFmpeg and FFprobe are ready in backend\tools"
