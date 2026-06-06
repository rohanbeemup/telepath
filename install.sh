#!/usr/bin/env bash
# Set up telepath: install deps, create .env, and (optionally)
# install a systemd --user service for 24/7 running. Safe to re-run.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_DIR"

command -v bun >/dev/null || { echo "bun not found — install from https://bun.sh"; exit 1; }
command -v claude >/dev/null || echo "warning: 'claude' not on PATH. Log in with 'claude' → /login first (subscription auth)."

echo "==> Installing dependencies"
bun install

if [ ! -f .env ]; then
  cp .env.example .env
  chmod 600 .env
  echo "==> Created .env (chmod 600). Edit it now: set TELEGRAM_BOT_TOKEN, ALLOWED_USER_ID, FORUM_CHAT_ID."
else
  echo "==> .env already exists — leaving it."
fi

echo
read -r -p "Install a systemd --user service for 24/7 running? [y/N] " ans
if [[ "${ans:-N}" =~ ^[Yy]$ ]]; then
  BUN_BIN="$(command -v bun)"
  UNIT_DIR="$HOME/.config/systemd/user"
  mkdir -p "$UNIT_DIR"
  sed -e "s#__REPO_DIR__#$REPO_DIR#g" -e "s#__BUN__#$BUN_BIN#g" \
    telepath.service.template > "$UNIT_DIR/telepath.service"
  systemctl --user daemon-reload
  systemctl --user enable --now telepath.service
  echo "==> Service installed. Logs: journalctl --user -u telepath -f"
  echo "    (For it to survive logout/reboot, run once: sudo loginctl enable-linger \"$USER\")"
else
  echo "==> Skipped systemd. Run manually with: bun run daemon.ts"
fi
