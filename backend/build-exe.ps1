param(
  [string]$NodePath = (Get-Command node -ErrorAction Stop).Source
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$ffmpegPath = Join-Path $PSScriptRoot "tools\ffmpeg.exe"
$outputPath = Join-Path $PSScriptRoot "DubroomBackend.exe"
$blobPath = Join-Path $PSScriptRoot "sea-prep.blob"

if (-not (Test-Path -LiteralPath $ffmpegPath)) {
  throw "FFmpeg not found at $ffmpegPath. Run backend\download-ffmpeg.ps1 first."
}

Push-Location $projectRoot
try {
  $env:Path = "$(Split-Path -Parent $NodePath);$env:Path"
  & $NodePath --experimental-sea-config (Join-Path $PSScriptRoot "sea-config.json")
  if ($LASTEXITCODE -ne 0) { throw "Node SEA preparation failed with exit code $LASTEXITCODE." }
  Copy-Item -LiteralPath $NodePath -Destination $outputPath -Force
  & (Join-Path $projectRoot "node_modules\.bin\postject.cmd") $outputPath NODE_SEA_BLOB $blobPath --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2
  if ($LASTEXITCODE -ne 0) { throw "SEA injection failed with exit code $LASTEXITCODE." }
} finally {
  Pop-Location
}

Write-Host "Created $outputPath"
