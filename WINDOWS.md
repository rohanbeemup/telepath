# Running telepath on Windows

telepath runs on Windows with Bun — no WSL needed. The only platform-specific
pieces are the installer (`install.ps1`) and the start scripts (`start.ps1` /
`start.bat`); the SDK resolves its bundled Claude Code binary per platform itself.
The Linux `install.sh` + systemd service are still there for Linux users.

This setup runs telepath **manually** — you start it when you want it, and stop
it with Ctrl+C. That's the safest mode for a bot that can run shell commands.

## Prerequisites

1. **Bun** — install in PowerShell:
   ```powershell
   irm bun.sh/install.ps1 | iex
   ```
   Restart the terminal, then check: `bun --version`.

2. **Claude Code**, logged in with a **subscription** (no API key). Install it,
   then run `claude` and `/login`. Check: `claude --version`.

3. A **Telegram bot** (from [@BotFather](https://t.me/BotFather)) and a **forum
   supergroup** with Topics enabled (group → Settings → enable *Topics*, add the
   bot as **admin** with **Manage Topics**).

## Install

From the repo folder in PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

This runs `bun install`, creates `.env` from `.env.example`, and locks `.env` to
your user (via `icacls` — the Windows equivalent of `chmod 600`, since it holds
the bot token).

## Configure `.env`

Open `.env` and set the three required values:

- `TELEGRAM_BOT_TOKEN` — from @BotFather.
- `ALLOWED_USER_ID` and `FORUM_CHAT_ID` — the daemon **requires** both at startup
  (it exits if either is missing), so it can't be the thing that shows them. Send
  `/start` in your forum group, then ask Telegram directly:

  ```powershell
  powershell -ExecutionPolicy Bypass -File .\get-ids.ps1
  ```

  It prints both lines ready to paste. (Do this while the daemon is **not**
  running — a running poller consumes the updates it reads.)

## Run

```powershell
powershell -ExecutionPolicy Bypass -File .\start.ps1
```

or just **double-click `start.bat`**.

On a healthy boot you'll see (pretty format on a terminal; JSON when stderr is a file):

```
10:31:02 info  preflight.claude_version message="claude binary 2.1.278" binary=...\node_modules\@anthropic-ai\claude-agent-sdk-win32-x64\claude.exe
10:31:03 info  telepath.up version=0.2.0 sdk=0.3.278 bot=<your-bot> chat=<FORUM_CHAT_ID> user=<ALLOWED_USER_ID> defaultModel=claude-sonnet-5 ...
10:31:03 info  telegram.polling as=<your-bot>
```

The SDK bundles its own Claude Code, so nothing has to be on PATH for the sessions.
Two lines to know:

- `preflight.claude_version` at level **warn** means the bundled binary is older than
  the Claude 5 models require (they answer `claude_code_version_too_old`). The fix is a
  newer SDK: bump `@anthropic-ai/claude-agent-sdk` in `package.json`, `bun install`, then
  `bun run smoke`. `CLAUDE_BINARY` in `.env` overrides the bundled binary for experiments.
- `telepath.boot_failed` means Telegram rejected the token or the network is down; the
  daemon exits with code 3 so a supervisor notices.

`/status` in the General topic (or 📊 Status in the menu) shows the same versions plus
live sessions, counters and the last errors while it runs; `health.json` next to the
daemon holds the same snapshot, rewritten every minute.

## Smoke test

In the **General** topic:

```
/new test cwd=C:\code\my-project
```

A topic appears. In that topic, type `what's in README.md` — a Read auto-runs and
the answer comes back. Then ask it to run a shell command; an **Allow/Deny** button
appears in the topic and the session blocks until you tap. `/auto on` skips the
prompts for that topic.

## Notes & differences from Linux

- **No systemd / service.** Manual start only (by design). Close the window or
  Ctrl+C to stop.
- **`.env` permissions** are enforced with `icacls`, not `chmod`. The
  `chmodSync(.env, 600)` call in `daemon.ts` is a harmless no-op on NTFS.
- **Paths** with backslashes work everywhere (`cwd=C:\path\to\repo`). `~` also
  expands to your home dir.
- Everything else (topics, menus and pinned controls, approvals, images, file
  delivery, resume) behaves exactly as in the main README.
