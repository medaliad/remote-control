# uninstall.ps1 — removes the Startup shortcut and stops any running agent.
# Leaves the repo + node_modules on disk; delete the folder yourself if you
# also want those gone.
[CmdletBinding()]
param()
$ErrorActionPreference = "SilentlyContinue"

$startup  = [Environment]::GetFolderPath("Startup")
$shortcut = Join-Path $startup "Remote Control Host.lnk"

if (Test-Path $shortcut) {
    Write-Host "==> Removing Startup shortcut: $shortcut" -ForegroundColor Cyan
    Remove-Item $shortcut -Force
} else {
    Write-Host "==> No Startup shortcut found." -ForegroundColor Cyan
}

Write-Host "==> Stopping any running rc-host processes…" -ForegroundColor Cyan
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -match "rc-host.mjs|combined-server.mjs" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

Write-Host "Done." -ForegroundColor Green
