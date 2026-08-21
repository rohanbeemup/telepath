# Start telepath (manual run). Stop with Ctrl+C.
#   powershell -ExecutionPolicy Bypass -File .\start.ps1
$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
  Write-Error "bun not found. Install it: powershell -c `"irm bun.sh/install.ps1 | iex`""
}
if (-not (Test-Path .env)) {
  Write-Error "No .env found. Run .\install.ps1 first, then fill in TELEGRAM_BOT_TOKEN / ALLOWED_USER_ID / FORUM_CHAT_ID."
}

bun run daemon.ts
