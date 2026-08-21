# Print ALLOWED_USER_ID and FORUM_CHAT_ID for your .env.
# The daemon requires both at startup, so it can't be the thing that shows them —
# this asks Telegram directly.
#   1. Put TELEGRAM_BOT_TOKEN in .env
#   2. Send /start in your forum group (the bot must be an admin there)
#   3. Stop the daemon if it's running, then: powershell -ExecutionPolicy Bypass -File .\get-ids.ps1
$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

if (-not (Test-Path .env)) { Write-Error "No .env found. Run .\install.ps1 first." }
$m = Select-String -Path .env -Pattern '^\s*TELEGRAM_BOT_TOKEN\s*=\s*(\S+)' | Select-Object -First 1
if (-not $m) { Write-Error "TELEGRAM_BOT_TOKEN is not set in .env." }
$token = $m.Matches[0].Groups[1].Value

$r = Invoke-RestMethod "https://api.telegram.org/bot$token/getUpdates"
if (-not $r.ok) { Write-Error "Telegram rejected the token." }

# A running daemon consumes updates, so getUpdates would come back empty.
$msgs = @($r.result | ForEach-Object { $_.message } | Where-Object { $_ })
if (-not $msgs) {
  Write-Host "No messages waiting. Stop the daemon if it's running, send /start in the group, and re-run this."
  exit 1
}
$last = $msgs[-1]
Write-Host ""
Write-Host "ALLOWED_USER_ID=$($last.from.id)   ($($last.from.username))"
Write-Host "FORUM_CHAT_ID=$($last.chat.id)     ($($last.chat.title))"
Write-Host ""
Write-Host "Paste those two lines into .env."
