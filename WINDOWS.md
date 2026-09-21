# Running telepath on Windows

telepath runs on Windows with Bun — no WSL needed. The only platform-specific
pieces are the installer (`install.ps1`), the start scripts (`start.ps1` /
`start.bat`), and the SDK binary resolution (handled in `daemon.ts`). The Linux
`install.sh` + systemd service are still there for Linux users.

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

On a healthy boot you'll see:

```
telepath up - chat <FORUM_CHAT_ID>, user <ALLOWED_USER_ID>, default claude-sonnet-5 @ effort default, models sonnet,opus, ...
  claude binary: ...\node_modules\@anthropic-ai\claude-agent-sdk-win32-x64\claude.exe
polling as @<your-bot>
```

If `claude binary:` shows just `claude.exe` (the PATH fallback) instead of a full
`...win32-x64\claude.exe` path, the SDK's bundled binary wasn't found — set
`CLAUDE_BINARY` in `.env` to your installed Claude Code executable, e.g.:

```
CLAUDE_BINARY=C:\Users\<you>\.bun\bin\claude.exe
```

(Find it with `where.exe claude` in PowerShell.)

If a topic's first message comes back with

```
API Error: 400 ... "Claude Code 2.1.117 does not support this model; version 2.1.251 or newer is required" ... claude_code_version_too_old
```

the bundled binary is too old for that model (the Claude 5 generation needs
2.1.251+), and the pinned SDK cannot simply be upgraded: newer SDK releases dropped
the `unstable_v2_*` session API this daemon is built on. Set `CLAUDE_BINARY` to a
newer Claude Code instead. Any of these work:

- a native install (`irm https://claude.ai/install.ps1 | iex`), which lands at
  `C:\Users\<you>\.local\bin\claude.exe` and keeps itself current — the durable option;
- the copy inside the VS Code extension,
  `C:\Users\<you>\.vscode\extensions\anthropic.claude-code-<version>-win32-x64\resources\native-binary\claude.exe`
  — works today, but the path carries the version, so re-point it when the extension updates.

An older SDK driving a newer binary is fine: the protocol is owned by the binary.

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
