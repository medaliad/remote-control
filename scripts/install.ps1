# install.ps1 — one-shot installer for the Remote Control host on Windows.
#
# Run with (PowerShell, user level — no admin needed):
#   iwr -useb https://your.intranet/install.ps1 | iex
# or from a cloned repo:
#   powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1
#
# What it does:
#   1. Verifies Node.js >= 18.
#   2. Runs `npm ci` and `npm run build:combined`.
#   3. Creates a Startup-folder shortcut so rc-host launches at every sign-in.
#   4. Starts the agent in the background.
#   5. Opens the host page in the default browser.
#
# Idempotent. No registry writes, no admin rights, nothing company MDM
# wouldn't allow. To roll out org-wide, push this script + the repo via Intune
# or your MDM of choice.

[CmdletBinding()]
param(
    [string]$RepoDir   = "",
    [int]   $Port      = 3000,
    [string]$DeviceName = "",
    [string]$RelayUrl   = ""
)

$ErrorActionPreference = "Stop"

function Info([string]$msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Warn([string]$msg) { Write-Host "==> $msg" -ForegroundColor Yellow }
function Die ([string]$msg) { Write-Host "ERROR: $msg" -ForegroundColor Red; exit 1 }

if (-not $RepoDir) {
    $RepoDir = Resolve-Path (Join-Path $PSScriptRoot "..")
}
$RepoDir = (Resolve-Path $RepoDir).Path
Info "Repo: $RepoDir"

# ── 1. Preflight ──────────────────────────────────────────────────────────────
$node = (Get-Command node -ErrorAction SilentlyContinue)
if (-not $node) { Die "Node.js is required. Install the LTS from https://nodejs.org and re-run." }
$ver = (& node -p "process.versions.node.split('.')[0]")
if ([int]$ver -lt 18) { Die "Node.js >= 18 required (found $(node -v))." }

if (-not (Test-Path (Join-Path $RepoDir "package.json"))) {
    Die "package.json not found in $RepoDir — is this the repo root?"
}

# ── 2. Deps + build ───────────────────────────────────────────────────────────
Info "Installing npm dependencies…"
Push-Location $RepoDir
try {
    & npm ci --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { Die "npm ci failed." }

    Info "Building the web UI…"
    & npm run build:combined
    if ($LASTEXITCODE -ne 0) { Die "build failed." }
} finally {
    Pop-Location
}

# ── 3. Startup-folder shortcut (per-user, no admin) ───────────────────────────
$startup    = [Environment]::GetFolderPath("Startup")
$shortcut   = Join-Path $startup "Remote Control Host.lnk"
$launcher   = Join-Path $RepoDir "bin\rc-host.mjs"
$nodePath   = $node.Source

if (-not (Test-Path $launcher)) { Die "Launcher not found: $launcher" }

$envPairs = @(
    "PORT=$Port",
    "NO_BROWSER=1"
)
if ($DeviceName) { $envPairs += "DEVICE_NAME=$DeviceName" }
if ($RelayUrl)   { $envPairs += "RELAY_URL=$RelayUrl" }

# Wrapper .cmd the Startup shortcut points at. Setting env inside the wrapper
# keeps everything self-contained so IT can copy the folder wholesale.
$wrapper   = Join-Path $RepoDir "scripts\rc-host-launch.cmd"
$setLines  = ($envPairs | ForEach-Object { "set $_" }) -join "`r`n"
$wrapperBody = @"
@echo off
cd /d "$RepoDir"
$setLines
"$nodePath" "$launcher"
"@
Set-Content -Path $wrapper -Value $wrapperBody -Encoding ASCII

Info "Creating Startup shortcut → $shortcut"
$shell = New-Object -ComObject WScript.Shell
$lnk   = $shell.CreateShortcut($shortcut)
$lnk.TargetPath       = $wrapper
$lnk.WorkingDirectory = $RepoDir
$lnk.WindowStyle      = 7  # Minimized
$lnk.IconLocation     = "$nodePath,0"
$lnk.Description      = "Remote Control host agent"
$lnk.Save()

# ── 4. Launch it now ──────────────────────────────────────────────────────────
Info "Starting the agent in the background…"
Start-Process -FilePath $wrapper -WindowStyle Hidden

# ── 5. Open browser ───────────────────────────────────────────────────────────
Start-Sleep -Seconds 3
$url = "http://localhost:$Port/host"
Start-Process $url

Write-Host ""
Write-Host "✓ Remote Control host installed." -ForegroundColor Green
Write-Host "  Auto-starts on sign-in. Dashboard: $url" -ForegroundColor Green
Write-Host ""
Write-Host "  To stop now:       Stop-Process -Name node -ErrorAction SilentlyContinue"
Write-Host "  To disable launch: Remove-Item '$shortcut'"
Write-Host ""
