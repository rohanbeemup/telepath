# Set up telepath on Windows: install deps, create .env (locked to your user).
# Windows equivalent of install.sh. Safe to re-run.
#   powershell -ExecutionPolicy Bypass -File .\install.ps1
$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
  Write-Error "bun not found. Install it, then re-run:`n  powershell -c `"irm bun.sh/install.ps1 | iex`""
}
if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
  Write-Warning "'claude' not on PATH. Install Claude Code and run 'claude' then '/login' (subscription auth) before starting."
}

Write-Host "==> Installing dependencies"
bun install
if ($LASTEXITCODE -ne 0) { Write-Error "bun install failed" }

if (-not (Test-Path .env)) {
  Copy-Item .env.example .env
  # Lock .env to the current user only (Windows equivalent of chmod 600 — it holds the bot token).
  icacls .env /inheritance:r /grant:r "$($env:USERNAME):F" | Out-Null
  if ($LASTEXITCODE -ne 0) {
    Write-Error "icacls failed - .env may still be readable by other users. Restrict it manually before putting a bot token in it."
  }
  Write-Host "==> Created .env (locked to $($env:USERNAME)). Edit it now: set TELEGRAM_BOT_TOKEN, ALLOWED_USER_ID, FORUM_CHAT_ID."
} else {
  Write-Host "==> .env already exists - leaving it."
}

Write-Host ""
Write-Host "==> Done. Next:"
Write-Host "    1. Fill TELEGRAM_BOT_TOKEN in .env (from @BotFather)."
Write-Host "    2. Send /start in your forum group, then read the two ids with:"
Write-Host "         .\get-ids.ps1"
Write-Host "       Put them in .env as ALLOWED_USER_ID and FORUM_CHAT_ID."
Write-Host "    3. Run .\start.ps1 - you're live. See WINDOWS.md for the full walkthrough."
