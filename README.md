# telepath

**Telegram ⇄ your machine's mind.** Run and steer **multiple Claude Code sessions from Telegram** — one forum **topic per resident session**, with **per-command approval** delivered as Allow/Deny buttons right in the chat. Claude runs on *your* machine (your files, your tools, your `claude login`); Telegram is just the remote control.

```
Telegram forum supergroup ("Claude")          one bot, one poller
  ├─ Topic "fix login bug"  ⇄  resident Claude session A
  ├─ Topic "infra audit"    ⇄  resident Claude session B   ← each topic = its own
  └─ Topic (General)        ── /new /list /attach /auto       conversation, on your box
            │
            ▼
   daemon.ts  (Bun + grammy + @anthropic-ai/claude-agent-sdk)
```

> Powered by Claude. Not affiliated with or endorsed by Anthropic.

## Why topics?

Telegram allows exactly **one poller per bot token**, and the Claude Agent SDK is one-session-per-process. So you can't have N independent bots. Instead, a single daemon holds the token and maps each **forum topic** (via `message_thread_id`) to its own resident SDK session. Because every session gets its own permission callback, **a tool's Allow/Deny prompt lands in its own topic** — concurrent approvals never collide.

## Features

- 🧵 **Topic per session** — talk in a topic, it continues that conversation; sessions persist to `~/.claude/projects` (so you can also resume them in your terminal).
- ✅ **Per-command approval** — Bash/Write/Edit/Web post an Allow/Deny button into the topic and the session blocks until you tap.
- ⚡ **Auto mode** — `/auto` per topic to run tools without prompts (opt-in, per topic).
- ❓ **Clarifying questions & plan mode** — `AskUserQuestion` renders as tappable option buttons; plan mode shows the full plan then asks to approve.
- 💸 **Cost controls** — Sonnet by default (`use opus` per topic), idle-eviction, and a concurrent-session cap.
- 🖼️ **Images** — send a photo to a topic and the session reads it.
- 🆔 **Resumable** — each new topic prints its session id + a `claude --resume …` command so you can pick it up on your laptop.
- 🔒 **Single-user** — only your Telegram user id can talk to it or approve anything.

## Prerequisites

- [**Bun**](https://bun.sh)
- **Claude Code**, logged in with a **subscription** (`claude` → `/login`). No API key — usage runs on your plan. *(API-key auth is not used.)*
- A **Telegram bot** (from [@BotFather](https://t.me/BotFather)) and a **forum supergroup** with Topics enabled.

## Quick start

```bash
git clone https://github.com/rohanbeemup/telepath.git
cd telepath
./install.sh            # installs deps, creates .env, optional systemd service
```

Then, on the Telegram side:

1. **Create a bot:** message [@BotFather](https://t.me/BotFather) → `/newbot` → copy the token.
2. **Create a forum group:** new group → Settings → enable **Topics** → add your bot as **admin** with the **Manage Topics** permission.
3. **Fill `.env`:** put the bot token in `TELEGRAM_BOT_TOKEN`. For the other two ids, the easiest path: run the daemon (`bun run daemon.ts`), send any message in the group, and read your `ALLOWED_USER_ID` and `FORUM_CHAT_ID` from the log. (Or use [@userinfobot](https://t.me/userinfobot).)
4. **Run it:** `bun run daemon.ts` — or, if you installed the service, it's already running (`journalctl --user -u telepath -f`).

## Usage

In the **General** topic:

| Command | What it does |
|---|---|
| `/new <name> [cwd=/path] [auto]` | Create a topic + session. `cwd=` sets the working dir; `auto` skips approvals. |
| `/list` | Recent sessions (📌 bound to a topic, 🟢 live) — includes ones started in your terminal. |
| `/attach <short-id> [name]` | Bind an existing session to a new topic and resume it. |
| `/auto [on\|off]` | Toggle auto mode for the current topic. |
| `/help` | Show help. |

In a **session topic**: just type. `use opus` / `use sonnet` switches that topic's model. Clarifying questions appear as buttons — tap one, or type your own reply.

## Run as a service (24/7)

`./install.sh` offers to install a **systemd `--user` service** from [`telepath.service.template`](telepath.service.template) (the placeholders `__REPO_DIR__` / `__BUN__` are filled in automatically). That gives you:

- **auto-start** at boot/login (`systemctl --user enable`),
- **auto-restart** on crash (`Restart=always`),
- **survives logout/reboot** via `loginctl enable-linger` — the installer runs this for you.

> ⚠️ **The linger step is what keeps it alive when you're not logged in.** Without it, a `--user` service stops the moment you log out and won't start at boot until you log back in — the most common reason telepath "only runs while my terminal is open." `install.sh` enables it automatically (needs `sudo` once).

Manage / debug it:

```bash
systemctl --user status telepath        # is it running?
systemctl --user restart telepath        # after editing daemon.ts or .env
journalctl --user -u telepath -f         # live logs
loginctl show-user "$USER" | grep Linger # should say Linger=yes
```

To set it up by hand instead of via `install.sh`:

```bash
sed -e "s#__REPO_DIR__#$PWD#g" -e "s#__BUN__#$(command -v bun)#g" \
  telepath.service.template > ~/.config/systemd/user/telepath.service
systemctl --user daemon-reload
systemctl --user enable --now telepath.service
sudo loginctl enable-linger "$USER"      # <-- don't skip this
```

## Configuration

All via `.env` (see [`.env.example`](.env.example)). Key options: `DEFAULT_MODEL`, `SONNET_MODEL`, `OPUS_MODEL`, `IDLE_MINUTES`, `MAX_LIVE_SESSIONS`, `DEFAULT_CWD`, `TG_CLAUDE_STATE_DIR`, `CLAUDE_BINARY`.

## How it works

The daemon (`daemon.ts`) holds the bot token and routes by `message_thread_id`. Each topic gets a resident session via the SDK's `unstable_v2_createSession` / `unstable_v2_resumeSession`, with a `canUseTool` callback that posts approval/question prompts into that topic. Read-only tools auto-run; sessions idle-evict and resume from their persisted transcript, so context survives restarts.

## Cost & billing

Usage runs on your Claude **subscription**, metered like any Claude Code usage — **Opus ≈ 5× Sonnet**, so the default is Sonnet and you opt into Opus per topic. Heavy use can hit your plan's rate limits (you'll see throttling).

> **Agent SDK billing — status (as of June 2026).** Anthropic announced a change (slated for **June 15, 2026**) that would move Agent SDK / `claude -p` usage on subscription plans to a **separate monthly Agent SDK credit** — then **paused it**. As of now **nothing has changed**: Agent SDK / `claude -p` usage (which is *all* of telepath, plus any `claude -p` cron jobs) draws from your **normal subscription rate limits exactly as before** — no separate credit, nothing to claim, limits unchanged. Anthropic has said they'll give **advance notice** before any future change.
>
> Why it still matters for telepath: telepath is **built on the Agent SDK**, so *if* that split returns, telepath's usage would fall under the Agent-SDK credit — whereas Claude Code **Remote Control** is **interactive-billed** (see the comparison below). If you ever need to decouple, an **API key** stays on plain pay-as-you-go and never hard-stops. Details: [Use the Agent SDK with your Claude plan](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) · [Agent SDK docs](https://code.claude.com/docs/en/agent-sdk).

## How is this different from Claude Code's Remote Control?

Claude Code ships a built-in [**Remote Control**](https://code.claude.com/docs/en/remote-control) feature (`claude remote-control`) that lets you drive your local sessions from **claude.ai / the Claude mobile app**, and its *server mode* even supports multiple concurrent sessions. It overlaps with telepath — so use the right tool:

| | **telepath** | **Remote Control** |
|---|---|---|
| Client | **Telegram** (any Telegram app) | claude.ai web + Claude mobile/desktop app only |
| Multi-session | One forum **topic** per session | Server mode: multiple sessions |
| Approvals | Custom **Allow/Deny buttons in the topic** | Native Claude UI |
| Switching one convo across devices | Hand-off only (don't co-drive the same session in two places) | **Real-time sync** across devices — purpose-built for this |
| **Survives reboot / restart** | ✅ topic↔session bindings persist (`registry.json`) — message the topic and it **resumes from the saved transcript** | ❌ a session ends when its process stops; the restarted server does **not** re-host it (you relaunch/resume by hand) |
| Maintenance | A small daemon you run | **Built-in, Anthropic-maintained** |
| Billing | Subscription (Agent SDK) | Subscription (interactive) — see billing note above |

**Rule of thumb:** if you just want to drive one conversation from your phone *and* laptop interchangeably, **Remote Control is the better, zero-maintenance choice.** Reach for telepath when you specifically want it **in Telegram** — multiple independent topic-threads, in the same app as your other bots/chats, with approval buttons inline and full control over the behavior. It's also the better pick for **long-running work you reboot through**: telepath resumes the topic's session after a restart (bindings persist on disk), whereas a Remote Control session ends with its process and has to be re-hosted by hand. The two can coexist (use Remote Control for a session you're actively co-driving; telepath for the rest) — just never drive the *same* session from both at once.

## Security

This bot can run shell commands and edit files on your machine, so treat it accordingly.

- **Single-user gate.** Every inbound message *and* every Allow/Deny tap is checked against `ALLOWED_USER_ID`; everything else is dropped. Only `message:text` and button callbacks are processed.
- **Keep the group private / solo.** Anyone *in* the forum group can read the bot's output (session content, tool results) even though only you can drive it. Don't add others.
- **Auto mode = remote code execution.** A topic in `/auto` runs tools with no prompt. That's the point, but it means a single Telegram message can run arbitrary commands. It's per-topic, off by default — enable it only for topics/work you trust, and be aware that untrusted content a session fetches (web pages, files) could attempt prompt-injection.
- **Bot token isolation.** The `TELEGRAM_BOT_TOKEN` is scrubbed from the environment passed to child sessions, so a compromised/injected session can't read or exfiltrate it. `.env` is force-chmod'd to `600` on load.
- **Auth.** Runs on your `claude login` (subscription). No API key is stored or used.
- **Your responsibility:** keep `.env` private (it's gitignored), keep the bot token secret, and don't expose the group.

## Caveats

- Built on the SDK's **`unstable_v2_*` (@alpha)** API — pinned to a specific version; it may change between SDK releases.
- **One bot = one instance = one user.** Each teammate runs their own (own bot, own group, own `claude login`).

## License

[MIT](LICENSE).
