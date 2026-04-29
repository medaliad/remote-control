# VE Admin Agent -- installer.
#
# What this script does, end to end:
#
#   1. Verifies Node.js is installed (offers a download link otherwise).
#   2. Copies the agent files to %LocalAppData%\VEAdminAgent\.
#   3. Runs `npm install` inside that copy so the agent has its `ws` dep.
#   4. Asks for the signaling server URL and the username to register as
#      (prefilling the OS username) and writes them to config.json.
#   5. Registers a Windows Scheduled Task named "VEAdminAgent" that runs at
#      every user logon, hidden, and respawns the agent if it crashes.
#   6. Starts the task immediately so the install is "live" without a reboot.
#
# Run me from an elevated *or* normal PowerShell -- the install lives entirely
# under the current user's profile, no admin rights needed. Re-run any time
# to update the binaries or the saved config.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File .\install.ps1
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 `
#       -ServerUrl "https://remote-control-cdqo.onrender.com" `
#       -Username  "Aisha Al Mansoori" `
#       -NonInteractive
#
# To uninstall: see uninstall.ps1.

[CmdletBinding()]
param(
    # Pre-fill these to skip the interactive prompts. Useful for IT mass
    # rollouts pushed via Intune / Group Policy / scripted onboarding.
    [string]$ServerUrl   = "",
    [string]$Username    = "",
    [string]$AllowedOrigin = "",
    # Non-interactive mode aborts (instead of prompting) if any required
    # value is still empty after parameter binding + env vars.
    [switch]$NonInteractive
)

$ErrorActionPreference = "Stop"

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
$ProgramName = "VEAdminAgent"
$InstallDir  = Join-Path $env:LOCALAPPDATA $ProgramName
$ConfigPath  = Join-Path $InstallDir       "config.json"
$LogPath     = Join-Path $InstallDir       "agent.log"
$SourceDir   = Split-Path -Parent $MyInvocation.MyCommand.Path
$TaskName    = $ProgramName

Write-Host ""
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "  VE Admin Agent installer" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host ("  Source : {0}" -f $SourceDir)
Write-Host ("  Target : {0}" -f $InstallDir)
Write-Host ""

# ---------------------------------------------------------------------------
# Step 1 -- Node.js check
# ---------------------------------------------------------------------------
# We invoke `node -v` and check both that it ran and that the version is at
# least 20 (the agent uses top-level await, which is fine on 14.8+ but the
# rest of the code targets 20). If anything fails we point the user at the
# official download page rather than trying to silently install Node -- that
# usually involves admin rights and can collide with corporate-managed
# Node installs.
$nodeOk = $false
try {
    $nodeVer = & node --version 2>$null
    if ($LASTEXITCODE -eq 0 -and $nodeVer -match '^v(\d+)') {
        $major = [int]$Matches[1]
        if ($major -ge 20) {
            $nodeOk = $true
            Write-Host ("[1/5] Node.js found: {0}" -f $nodeVer) -ForegroundColor Green
        } else {
            Write-Host ("[1/5] Node.js {0} is too old -- need v20+." -f $nodeVer) -ForegroundColor Yellow
        }
    }
} catch { }

if (-not $nodeOk) {
    Write-Host ""
    Write-Host "Node.js v20 or later is required." -ForegroundColor Red
    Write-Host "Download from https://nodejs.org/en/download (LTS is fine)."
    Write-Host "Re-run this installer after Node finishes installing."
    exit 1
}

# ---------------------------------------------------------------------------
# Step 2 -- Copy files
# ---------------------------------------------------------------------------
# We deliberately copy rather than symlink so the install is self-contained
# and survives the source folder moving / being deleted. Excludes:
#   - node_modules   (npm install rebuilds these per machine arch)
#   - install*.ps1   (no need to ship the installer with itself)
#   - test-*.js      (dev-only scripts)
Write-Host ""
Write-Host "[2/5] Copying agent files..." -ForegroundColor Cyan
New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null

$exclude = @("node_modules", "install.ps1", "uninstall.ps1", "test-*.js")
Get-ChildItem -Path $SourceDir -Force | Where-Object {
    $name = $_.Name
    -not ($exclude | Where-Object { $name -like $_ })
} | ForEach-Object {
    Copy-Item -Path $_.FullName -Destination $InstallDir -Recurse -Force
}
Write-Host "      done." -ForegroundColor Green

# ---------------------------------------------------------------------------
# Step 3 -- npm install
# ---------------------------------------------------------------------------
# `--omit=dev` keeps the install footprint small (only `ws` ends up under
# node_modules). `--no-audit --no-fund` cuts down on noisy stdout for end
# users running this from a UAC-elevated terminal.
Write-Host ""
Write-Host "[3/5] Installing dependencies..." -ForegroundColor Cyan
Push-Location $InstallDir
try {
    & npm.cmd install --omit=dev --no-audit --no-fund 2>&1 | ForEach-Object {
        # Indent npm output so it visually nests under our log lines.
        Write-Host ("      {0}" -f $_)
    }
    if ($LASTEXITCODE -ne 0) {
        throw "npm install failed (exit $LASTEXITCODE). Check the output above."
    }
}
finally {
    Pop-Location
}
Write-Host "      done." -ForegroundColor Green

# ---------------------------------------------------------------------------
# Step 4 -- Config
# ---------------------------------------------------------------------------
# We try in this order:
#   - explicit -ServerUrl / -Username CLI args (for unattended installs)
#   - existing config.json (re-installs preserve previous answers)
#   - environment variables AUTOPAIR_URL / AUTOPAIR_USER
#   - interactive prompt (or hard-fail if -NonInteractive)
Write-Host ""
Write-Host "[4/5] Saving configuration..." -ForegroundColor Cyan

$existing = @{}
if (Test-Path $ConfigPath) {
    try {
        $existing = Get-Content -Raw -Path $ConfigPath | ConvertFrom-Json -AsHashtable
    } catch {
        Write-Host ("      Existing config.json unreadable, starting fresh: {0}" -f $_.Exception.Message) -ForegroundColor Yellow
        $existing = @{}
    }
}

function Resolve-Value([string]$cliValue, [string]$cfgKey, [string]$envName, [string]$prompt, [string]$default) {
    if ($cliValue) { return $cliValue }
    if ($existing.ContainsKey($cfgKey) -and $existing[$cfgKey]) { return [string]$existing[$cfgKey] }
    $envValue = [Environment]::GetEnvironmentVariable($envName, "Process")
    if ($envValue) { return $envValue }
    if ($NonInteractive) {
        throw "Missing $cfgKey (CLI/env/config) and -NonInteractive was set."
    }
    $defaultLabel = if ($default) { " [$default]" } else { "" }
    $entered = Read-Host "$prompt$defaultLabel"
    if (-not $entered) { return $default }
    return $entered
}

$resolvedUrl  = Resolve-Value $ServerUrl     "autopairUrl"   "AUTOPAIR_URL"   "Signaling server URL"          "https://remote-control-cdqo.onrender.com"
$resolvedUser = Resolve-Value $Username      "autopairUser"  "AUTOPAIR_USER"  "Username to register as"        $env:USERNAME
$resolvedOrig = Resolve-Value $AllowedOrigin "allowedOrigin" "ALLOWED_ORIGIN" "Allowed origin (leave default)" $resolvedUrl

# Normalize the username to the same canonical form the server uses
# (trimmed + lower-cased). The server's lookupAgent() and the VE Admin
# Flutter app both call .trim().toLowerCase() on usernames, so writing
# the value in canonical form here means there's exactly one source of
# truth on disk -- no "Dali" vs "dali" mismatches at session-open time.
$resolvedUser = $resolvedUser.Trim().ToLower()

# Preserve fields we didn't touch (e.g. autopairAgentId set on first run).
$config = $existing.Clone()
$config.autopairUrl    = $resolvedUrl
$config.autopairUser   = $resolvedUser
$config.allowedOrigin  = $resolvedOrig
$config | ConvertTo-Json -Depth 5 | Set-Content -Path $ConfigPath -Encoding UTF8

Write-Host ("      autopairUrl  = {0}" -f $resolvedUrl)
Write-Host ("      autopairUser = {0}" -f $resolvedUser)
Write-Host ("      allowedOrigin= {0}" -f $resolvedOrig)
Write-Host ("      written to   {0}" -f $ConfigPath)

# ---------------------------------------------------------------------------
# Step 5 -- Scheduled Task
# ---------------------------------------------------------------------------
# We register a per-user Scheduled Task instead of a Windows Service for
# three reasons:
#   1. It runs in the user's interactive session (services run in session 0
#      and can't drive the *user's* cursor without privileged session
#      switching).
#   2. It needs no admin rights to register -- `Register-ScheduledTask`
#      under HKCU works for the current user.
#   3. The task settings let us auto-respawn on failure and start hidden,
#      so end users never see a flickering console window at logon.
#
# To inspect: `taskschd.msc` -> Task Scheduler Library -> VEAdminAgent.
Write-Host ""
Write-Host "[5/5] Registering autostart task..." -ForegroundColor Cyan

$nodeExe = (Get-Command node).Source

# We used to pass the whole launch command inline via `-Command "..."`.
# That mostly worked but had two failure modes that bit users in the wild:
#
#   (a) Task Scheduler stores the Argument as a single string and Windows
#       splits it on whitespace before powershell.exe ever sees it. Single
#       quotes are NOT recognized by the OS-level tokenizer, so paths
#       containing spaces (e.g. "C:\Program Files\nodejs\node.exe") got
#       broken across multiple argv entries. PowerShell then re-joins those
#       under -Command, which usually works -- but on machines with
#       constrained-language mode or aggressive AV the recovery silently
#       fails and the task starts powershell.exe with no script body, so
#       the agent never launches at all.
#   (b) Anything that depends on $env:PATH being fully populated at logon
#       time is fragile: Scheduled Tasks see an early, partial PATH on some
#       Windows builds, so a bare `node agent.js` could fail to find node.
#
# Writing a real run-agent.ps1 wrapper next to agent.js, and pointing the
# task at it via -File, fixes both: -File takes a single quoted path (no
# tokenization mistakes) and the wrapper bakes the full node.exe path in.
# It also gives us a clean place to source config.json into env vars as
# belt-and-braces, so even a botched config.json read inside agent.js can
# fall back to env values.
$RunnerPath = Join-Path $InstallDir "run-agent.ps1"
# Embed $nodeExe at install time. Keep $PSScriptRoot, $env:..., $cfg, etc.
# as runtime variables by escaping them with backticks below.
$runner = @"
# Auto-generated by install.ps1. Do not edit by hand -- changes are
# overwritten on the next install.
`$ErrorActionPreference = 'Continue'
Set-Location -Path `$PSScriptRoot

# Belt-and-braces: pull the saved config into environment variables so the
# agent has a second source of truth even if it fails to read config.json
# for any reason. agent.js's pick() checks env vars first, then config.json.
try {
  `$cfgPath = Join-Path `$PSScriptRoot 'config.json'
  if (Test-Path `$cfgPath) {
    `$cfg = Get-Content -Raw -Path `$cfgPath | ConvertFrom-Json
    if (`$cfg.autopairUrl)   { `$env:AUTOPAIR_URL   = `$cfg.autopairUrl }
    if (`$cfg.autopairUser)  { `$env:AUTOPAIR_USER  = `$cfg.autopairUser }
    if (`$cfg.allowedOrigin) { `$env:ALLOWED_ORIGIN = `$cfg.allowedOrigin }
  }
} catch {
  Write-Output ("[run-agent] could not load config.json: " + `$_.Exception.Message)
}

# Use the full path baked in at install time so we don't depend on the
# task's $env:PATH having node on it.
& "$nodeExe" (Join-Path `$PSScriptRoot 'agent.js') *>> (Join-Path `$PSScriptRoot 'agent.log')
"@
Set-Content -Path $RunnerPath -Value $runner -Encoding ASCII

$action = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$RunnerPath`"" `
    -WorkingDirectory $InstallDir
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
# `RepetitionInterval` re-fires every 5 min if the previous run died, so a
# crashed agent recovers without the user having to log out + back in.
$trigger.Repetition = (New-ScheduledTaskTrigger -Once -At ([DateTime]::Now) -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration ([TimeSpan]::FromDays(365))).Repetition

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Days 365) `
    -MultipleInstances IgnoreNew `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -RestartCount 3
$settings.DisallowStartIfOnBatteries = $false

$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive

# `Register-ScheduledTask -Force` replaces an existing task with the same
# name in place -- important for re-installs / version upgrades.
Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Description "VE Admin remote-support agent. Registers this PC's username with the signaling server and pops the host page on demand." `
    -Force | Out-Null

# Kick it off right now so the install is functional without a logout.
Start-ScheduledTask -TaskName $TaskName | Out-Null

Write-Host ("      task registered as '{0}' and started." -f $TaskName) -ForegroundColor Green

Write-Host ""
Write-Host "============================================================" -ForegroundColor Green
Write-Host "  Install complete." -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Green
Write-Host "  Agent log:  $LogPath"
Write-Host "  Config:     $ConfigPath"
Write-Host "  Task:       Task Scheduler -> $TaskName"
Write-Host ""
Write-Host "  To verify, run:" -ForegroundColor Cyan
Write-Host "    Get-ScheduledTask -TaskName $TaskName | Get-ScheduledTaskInfo"
Write-Host "    Get-Content -Wait $LogPath"
Write-Host ""
