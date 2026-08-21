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
- 🔘 **Buttons for everything** — a menu in General (new / list / resume / settings) and a **pinned control panel** in every session topic (model, approvals, close, delete, wipe). Commands still work; you rarely need them from a phone.
- ⚡ **Auto mode** — per topic, run tools without prompts (opt-in, one tap or `/auto`).
- ❓ **Clarifying questions & plan mode** — `AskUserQuestion` renders as tappable option buttons; plan mode shows the full plan then asks to approve.
- 💸 **Cost controls** — Sonnet by default (`use opus` per topic), idle-eviction, and a concurrent-session cap.
- ⏳ **Rate-limit auto-resume** — a turn cut off by a hard rate limit is picked up again automatically when the window resets, instead of stalling until you notice.
- 🖼️ **Files both ways** — send a photo or document into a topic and the session reads it; anything the session drops in its `TELEPATH_OUTBOX` folder is delivered back to the topic (images as photos, the rest as documents).
- ✍️ **Formatted replies** — Claude's Markdown is rendered as Telegram HTML (bold, headings, lists, code, links, tables), with a plain-text fallback so a message is never dropped.
- 🆔 **Resumable** — each new topic prints its session id + a `claude --resume …` command so you can pick it up on your laptop.
- 🪟 **Linux, macOS and Windows** — Bun everywhere; `install.sh` + systemd on Linux, `install.ps1` / `start.bat` on Windows (see [`WINDOWS.md`](WINDOWS.md)).
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

> **On Windows?** Skip `install.sh` and use `install.ps1` + `start.ps1` (or `start.bat`) instead — see [`WINDOWS.md`](WINDOWS.md) for the full walkthrough.

Then, on the Telegram side:

1. **Create a bot:** message [@BotFather](https://t.me/BotFather) → `/newbot` → copy the token.
2. **Create a forum group:** new group → Settings → enable **Topics** → add your bot as **admin** with the **Manage Topics** permission.
3. **Fill `.env`:** put the bot token in `TELEGRAM_BOT_TOKEN`. For the other two ids, the easiest path: run the daemon (`bun run daemon.ts`), send any message in the group, and read your `ALLOWED_USER_ID` and `FORUM_CHAT_ID` from the log. (Or use [@userinfobot](https://t.me/userinfobot).)
4. **Run it:** `bun run daemon.ts` — or, if you installed the service, it's already running (`journalctl --user -u telepath -f`).

## Usage

In the **General** topic, send anything (or `/menu`) to get the menu:

| Button | What it does |
|---|---|
| 🆕 **New session** | Three taps: pick a project folder (scanned from `REPOS_DIR`, git repos first), a model, then approvals-vs-auto. |
| ⚡ **Quick new** | One tap: a session in your default folder + default model. |
| 📋 **My sessions** | Past sessions as buttons (📌 bound, 🟢 live) — including ones started in your terminal. Tap one to reopen it. |
| ▶️ **Resume last** | Jump straight into the most recently active session. |
| ⚙️ **Settings** | Default model + default folder for new sessions (persisted in `prefs.json`). |

In a **session topic**: just type. A 📌 **pinned control panel** sits at the top of every session topic:

| Button | What it does |
|---|---|
| ⚡ Sonnet / 🧠 Opus | Switch this topic's model (applies on the next message). |
| 🔐 Approvals ↔ ⚡ Auto | Toggle whether risky tools ask before running. |
| 💾 Close & keep | Stop the session and close the topic; context is kept and a ♻️ **Reopen** button resumes it. |
| 🗑 Close & delete | Remove the topic + binding. The transcript stays on disk (still `claude --resume`-able). |
| 🧹 Close, delete & remove all | Full wipe: topic, binding, delivered files **and** the transcript — no longer resumable. Asks to confirm first. |

Clarifying questions appear as buttons — tap one, or type your own reply. Typing still works for everything: `use opus` / `use sonnet` switches model, and the commands below are unchanged.

<details>
<summary>Typed commands</summary>

| Command | What it does |
|---|---|
| `/menu` | Menu in General, control panel in a session topic. |
| `/new <name> [cwd=/path] [auto]` | Create a topic + session. `cwd=` sets the working dir; `auto` skips approvals. |
| `/list` | Your sessions as buttons. |
| `/attach <short-id> [name]` | Bind an existing session to a new topic and resume it. |
| `/auto [on\|off]` | Toggle auto mode for the current topic. |
| `/help` | Show help. |

</details>

### Getting files out

Each session gets a `TELEPATH_OUTBOX` directory in its environment, and is told once — at the start of the conversation — that anything it writes there is delivered to you in the topic. So "screenshot that", "chart it", "export the report" arrive as a photo or document instead of a description. Delivered files are removed from the outbox after Telegram accepts them; a failed send stays put and is retried after the next turn.

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

All via `.env` (see [`.env.example`](.env.example)). Key options: `DEFAULT_MODEL`, `SONNET_MODEL`, `OPUS_MODEL`, `FABLE_MODEL`, `ENABLED_MODELS`, `REPOS_DIR`, `IDLE_MINUTES`, `MAX_LIVE_SESSIONS`, `DEFAULT_CWD`, `TG_CLAUDE_STATE_DIR`, `CLAUDE_BINARY`.

- **`ENABLED_MODELS`** (default `sonnet,opus`) decides which models the menus offer — list only what your auth can actually use. Fable 5 is **not** on the Claude subscription, so it is off by default; add `fable` only if your auth has it. Topics still pinned to a now-disabled model are migrated to the default on boot, so a session can't get stuck failing on a model you can't reach.
- **`REPOS_DIR`** (default: the parent of `DEFAULT_CWD`) is the root the folder picker scans. Git repos sort first, then other project folders by recency.
- Runtime state lives next to the daemon (or in `TG_CLAUDE_STATE_DIR`): `registry.json` (topic → session), `prefs.json` (menu defaults), `outbox/<topic>/` (files awaiting delivery). All gitignored.

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

- **Single-user gate.** Every inbound message *and* every Allow/Deny tap is checked against **both** your `ALLOWED_USER_ID` and the `FORUM_CHAT_ID`; everything else is dropped.
- **Keep the group private / solo.** Anyone *in* the forum group can read the bot's output (session content, tool results) even though only you can drive it. Don't add others.
- **Auto mode = remote code execution.** A topic in `/auto` runs tools with no prompt. That's the point, but it means a single Telegram message can run arbitrary commands. It's per-topic, off by default — enable it only for topics/work you trust, and be aware that untrusted content a session fetches (web pages, files) could attempt prompt-injection.
- **Bot token handling.** The `TELEGRAM_BOT_TOKEN` is scrubbed from the environment passed to child sessions (so a prompt-injected session can't read it from *its env*), and `.env` is force-chmod'd to `600` on load. This is **not** a sandbox, though: a session running tools (`Bash`/`Read`) — especially in `/auto` — can still read the `.env` file on disk like any other local file. The real protections are the single-user gate and keeping auto-mode off for untrusted work.
- **Child sessions inherit your environment** (minus the bot token). If you export other secrets (e.g. `ANTHROPIC_API_KEY`, cloud credentials) in the shell that launches the daemon, child sessions can see them — run the daemon from a clean environment if that matters.
- **Auth.** Runs on your `claude login` (subscription). No API key is stored or used.
- **Your responsibility:** keep `.env` private (it's gitignored), keep the bot token secret, and don't expose the group.

## Caveats

- Built on the SDK's **`unstable_v2_*` (@alpha)** API — pinned to a specific version; it may change between SDK releases.
- **One bot = one instance = one user.** Each teammate runs their own (own bot, own group, own `claude login`).

## License

[MIT](LICENSE).
