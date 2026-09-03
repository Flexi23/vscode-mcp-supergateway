$ErrorActionPreference = 'Stop'

$composeFile = Join-Path $PSScriptRoot '..\docker-compose.yml'
$composeFile = [System.IO.Path]::GetFullPath($composeFile)

$paths = @(
    'C:\gitlab.uni-rostock.de\limati-inf\supergateway-cbm-cache',
    'C:\gitlab.uni-rostock.de\limati-inf\supergateway-data'
)

foreach ($path in $paths) {
    if (Test-Path -LiteralPath $path) {
        Remove-Item -LiteralPath $path -Recurse -Force
        Write-Host "removed $path"
    }
    else {
        Write-Host "missing $path"
    }
}

Write-Host "Stopping docker compose stack..."
& docker compose -f $composeFile down
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "Starting docker compose stack..."
& docker compose -f $composeFile up -d --build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "Reset complete."
