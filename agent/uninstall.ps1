# VE Admin Agent — uninstaller.
#
# Reverses what install.ps1 set up:
#   1. Stops + unregisters the Scheduled Task.
#   2. Removes %LocalAppData%\VEAdminAgent\.
#
# Anything written by the agent itself outside that folder (browser tabs
# the agent popped, OS log entries, etc.) is left alone — same way uninstall
# handlers work in normal Windows installers.
#
# Pass -KeepConfig to preserve the saved username/URL across a reinstall.

[CmdletBinding()]
param(
    [switch]$KeepConfig
)

$ErrorActionPreference = "Stop"

$ProgramName = "VEAdminAgent"
$InstallDir  = Join-Path $env:LOCALAPPDATA $ProgramName
$ConfigPath  = Join-Path $InstallDir       "config.json"
$TaskName    = $ProgramName

Write-Host ""
Write-Host "Uninstalling $ProgramName..." -ForegroundColor Cyan

# 1. Scheduled Task — `-ErrorAction SilentlyContinue` so a partial install
#    (no task) doesn't leave us in a broken state.
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task) {
    try { Stop-ScheduledTask -TaskName $TaskName } catch { }
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "  - Scheduled Task '$TaskName' removed."
} else {
    Write-Host "  - No Scheduled Task '$TaskName' found (skipping)."
}

# 2. Files. If -KeepConfig, snapshot config.json into a temp file and put
#    it back after we wipe the folder.
$savedConfig = $null
if ($KeepConfig -and (Test-Path $ConfigPath)) {
    $savedConfig = Get-Content -Raw -Path $ConfigPath
    Write-Host "  - config.json preserved (-KeepConfig)."
}

if (Test-Path $InstallDir) {
    # Try a few times — antivirus or a still-running agent can briefly
    # lock files. The Scheduled Task is gone by now, so this should
    # succeed on the first or second attempt.
    for ($i = 0; $i -lt 3; $i++) {
        try {
            Remove-Item -Path $InstallDir -Recurse -Force
            break
        } catch {
            Start-Sleep -Milliseconds 500
            if ($i -eq 2) { throw }
        }
    }
    Write-Host "  - $InstallDir removed."
} else {
    Write-Host "  - $InstallDir not present (skipping)."
}

if ($savedConfig) {
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
    $savedConfig | Set-Content -Path $ConfigPath -Encoding UTF8
    Write-Host "  - config.json restored at $ConfigPath."
}

Write-Host ""
Write-Host "Uninstall complete." -ForegroundColor Green
