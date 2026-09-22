# telepath

**Telegram ⇄ your machine's mind.** Run and steer **multiple Claude Code sessions from Telegram** — one forum **topic per resident session**, with **per-command approval** delivered as Allow/Deny buttons right in the chat. Claude runs on *your* machine (your files, your tools, your `claude login`); Telegram is just the remote control.

```
Telegram forum supergroup ("Claude")          one bot, one poller
  ├─ Topic "fix login bug"  ⇄  resident Claude session A
  ├─ Topic "infra audit"    ⇄  resident Claude session B   ← each topic = its own
  └─ Topic (General)        ── menu: new / list / resume       conversation, on your box
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
- ⏳ **Rate-limit auto-resume** — a turn cut off by a hard rate limit is picked up again automatically when the window resets, instead of stalling until you notice. With [claude-rotator](https://github.com/yom-ooo/claude-rotator) installed, every rate-limit event is relayed to it so it can switch accounts, and the topic then continues at once instead of waiting for the reset.
- 🖼️ **Files both ways** — send a photo or document into a topic and the session reads it; anything the session drops in its `TELEPATH_OUTBOX` folder is delivered back to the topic (images as photos, the rest as documents).
- ✍️ **Formatted replies** — Claude's Markdown is rendered as Telegram HTML (bold, headings, lists, code, links), with a plain-text fallback so a message is never dropped. Tables become one labelled block per row, because Telegram never wraps a `<pre>` grid and a phone shows you a sliver of it.
- 🆔 **Resumable** — each new topic prints its session id + a `claude --resume …` command so you can pick it up on your laptop.
- 📊 **Observable** — structured JSON logs, per-process counters, a Status screen and a `health.json` on disk, so a silent failure is a number you can read rather than a silence you have to notice.
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
3. **Fill `.env`:** put the bot token in `TELEGRAM_BOT_TOKEN`. The daemon *requires* `ALLOWED_USER_ID` and `FORUM_CHAT_ID` at startup and exits without them, so get them from Telegram first: send `/start` in the group (with the daemon stopped, so it isn't eating the updates), then

   ```bash
   curl -s "https://api.telegram.org/bot<TOKEN>/getUpdates" |
     jq '.result[-1].message | {ALLOWED_USER_ID: .from.id, FORUM_CHAT_ID: .chat.id}'
   ```

   On Windows: `.\get-ids.ps1` does the same. (For just the user id, [@userinfobot](https://t.me/userinfobot) also works.)
4. **Run it:** `bun run daemon.ts` — or, if you installed the service, it's already running (`journalctl --user -u telepath -f`).

## Usage

In the **General** topic, send anything (or `/menu`) to get the menu:

| Button | What it does |
|---|---|
| 🆕 **New session** | Four taps: pick a project folder (scanned from `REPOS_DIR`, git repos first), a model, an effort level (low → max; skipped for Haiku), then approvals-vs-auto. |
| ⚡ **Quick new** | One tap: a session in your default folder + default model + default effort. |
| 📋 **My sessions** | Past sessions as buttons (📌 bound, 🟢 live) — including ones started in your terminal. Tap one to reopen it. |
| ▶️ **Resume last** | Jump straight into the most recently active session. |
| ⚙️ **Settings** | Default model, default effort + default folder for new sessions (persisted in `prefs.json`). |

In a **session topic**: just type. A 📌 **pinned control panel** sits at the top of every session topic:

| Button | What it does |
|---|---|
| 🐇 Haiku / ⚡ Sonnet / 🧠 Opus / ✨ Fable | Switch this topic's model (applies on the next message). Only the packages in `ENABLED_MODELS` are shown. |
| 🎚 low / med / high / xhigh / max / ↺ default | How hard this topic's model thinks (Claude Code's effort level; applies on the next message). Hidden for Haiku, which has no levels. |
| 🔐 Approvals ↔ ⚡ Auto | Toggle whether risky tools ask before running. |
| 🔎 Activity feed | One short line per tool call (🖥 command, 📖 read, ✏️ edit, 🔍 search, 🤖 subagent), batched every few seconds. On by default in ⚡ auto, where no approval prompts show what the session is doing and a model deep in a long task may not narrate for an hour; off by default under approvals. Typed: `feed on` / `feed off`. |
| 💾 Close & keep | Stop the session and close the topic; context is kept and a ♻️ **Reopen** button resumes it. |
| 🗑 Close & delete | Remove the topic + binding. The transcript stays on disk (still `claude --resume`-able). |
| 🧹 Close, delete & remove all | Full wipe: topic, binding, delivered files **and** the transcript — no longer resumable. Asks to confirm first. |

Clarifying questions appear as buttons — tap one, or type your own reply. Typing still works for everything: `use fable high` / `use opus` switches model (with an optional effort level), `effort max` / `effort default` changes only the effort, and the commands below are unchanged.

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

All via `.env` (see [`.env.example`](.env.example)). Key options: `DEFAULT_MODEL`, `DEFAULT_EFFORT`, `HAIKU_MODEL`, `SONNET_MODEL`, `OPUS_MODEL`, `FABLE_MODEL`, `ENABLED_MODELS`, `REPOS_DIR`, `IDLE_MINUTES`, `MAX_LIVE_SESSIONS`, `DEFAULT_CWD`, `TG_CLAUDE_STATE_DIR`, `CLAUDE_BINARY`, `ROTATOR_HANDOFF`.

- **Account rotator.** Sessions spawned here talk to the claude binary directly, so the rotator's VS Code shim never sees their `rate_limit_event`s. When `~/.claude-rotator/rotator.py` exists, the daemon relays every event itself (`rotator.py limit-event --stdin`, the shim's own contract) and appends it to `~/.claude-accounts/limit-events.log`, so the rotator sees the budget these topics burn on the shared account. After a rejection it watches the rotator's `.active` marker for about 30 s; when the account changes, the topic's claude process (still holding the old token) is closed and the session resumes at once on the new one, with its context intact. `ROTATOR_HANDOFF=off` disables this; `CLAUDE_ROTATOR_PY`, `CLAUDE_ROTATOR_SCRIPT` and `CLAUDE_ROTATOR_HOME` mirror the shim's overrides.

- **Model packages.** Four keys — `haiku`, `sonnet`, `opus`, `fable` — each mapped to a model id by its `*_MODEL` variable (defaults: Haiku 4.5, Sonnet 5, Opus 5, Fable 5.1). Pin an older generation by changing the id, e.g. `OPUS_MODEL=claude-opus-4-8`. The menus show the friendly name; the wizard and Settings also print which id each key resolves to.
- **`ENABLED_MODELS`** (default `sonnet,opus`) decides which packages the menus offer — list only what your auth can actually use; a model your plan lacks fails on the first message of a topic. Fable is premium and not on every plan, so it is off by default. Topics still pinned to a now-disabled model are migrated to the default on boot, so a session can't get stuck failing on a model you can't reach.
- **Claude binary.** The SDK bundles its own Claude Code (0.3.278 ships 2.1.278), and that binary decides which models exist: the Claude 5 generation needs 2.1.251 or newer, and an older one answers `claude_code_version_too_old` on a topic's first message. Boot reads the version and logs a warning when it is below the minimum. `CLAUDE_BINARY` overrides the bundled binary for experiments; the normal fix for an old binary is `bun install` after bumping the SDK.
- **Effort.** Claude Code's effort level (`low`, `medium`, `high`, `xhigh`, `max`) is chosen per topic: in the 🆕 wizard, on the pinned panel, or by typing `effort xhigh`. `DEFAULT_EFFORT` seeds new topics; unset means Claude Code decides (its `settings.json` `effortLevel` or built-in default). It is passed to the session as the SDK's `effort` option, so switching effort restarts the topic's process and applies on the next message. Haiku 4.5 has no effort levels, so the buttons are hidden for it.
- **Logging and status.** Every log line is one JSON object on stderr (`ts`, `lvl`, `ev`, fields), so `journalctl` output can be filtered and counted; `LOG_LEVEL` (default `info`, `debug` adds every send and the claude process's stderr) and `LOG_FORMAT=pretty` (default on a terminal) control it. 📊 **Status** in the menu, `/status`, and `<state-dir>/health.json` (rewritten every minute) show uptime, versions, live sessions, counters and the last errors.
- **`REPOS_DIR`** (default: the parent of `DEFAULT_CWD`) is the root the folder picker scans. Git repos sort first, then other project folders by recency.
- Runtime state lives next to the daemon (or in `TG_CLAUDE_STATE_DIR`): `registry.json` (topic → session), `prefs.json` (menu defaults), `outbox/<topic>/` (files awaiting delivery), `health.json`. All gitignored. Note that **Bun preloads `./.env` from the working directory** before the daemon reads `TG_CLAUDE_STATE_DIR/.env`, and the shell wins over the file: to run a second state directory from the repo folder, pass `bun --env-file=<state-dir>/.env run daemon.ts`, or you will start a second poller on the first `.env`'s token.

## How it works

`daemon.ts` is the bootstrap: it loads and validates `.env`, opens the state files, runs a preflight (claude binary version, bot identity) and wires the modules under `src/`. Each topic gets a resident session through the Agent SDK's `query()` with streaming input: a per-topic mailbox feeds user messages in for as long as the topic lives, and one reader consumes the session's output. A `canUseTool` callback posts approval and question prompts into that topic; read-only tools auto-run; sessions idle-evict and resume from their persisted transcript by id, so context survives restarts.

```
daemon.ts             bootstrap: config → log → state → preflight → backend → topics → bot
src/config.ts         .env parsing and validation; every problem reported at once
src/models.ts         model packages, effort levels, labels
src/state.ts          registry.json / prefs.json (atomic writes, migrations at load)
src/log.ts            JSON-lines logger, counters, error ring
src/mailbox.ts        the push iterable that keeps a query() resident
src/session.ts        the SDK boundary: query(), listSessions()
src/interpret.ts      SDK message → typed events (what a message means for the topic)
src/feed.ts           tool-call and task lines, batched
src/topics.ts         live sessions, cap, idle eviction, rate-limit resume, rotation watch
src/commands.ts       the typed-text grammar (use / effort / feed / slash)
src/ui/               keyboards, panel texts, the wizard state machine
src/bot.ts            grammy handlers: Telegram in, Telegram out
src/files.ts          outbox / inbox / transcript removal
src/markdown.ts       markdown → Telegram HTML, rendered on a worker with a deadline
src/rotator.ts        hand-off to claude-rotator
```

Everything that decides something is a pure module with a test; `src/bot.ts` and `src/session.ts` are the two edges that touch Telegram and the claude process.

## Development

```bash
bun install
bun run check          # tsc --noEmit over the whole tree, then every test
bun test               # 117 tests, no network, no token, no claude process
bun run typecheck
bun run smoke          # Ring 2: one real session through the SDK (spends a few tokens)
```

Behaviour changes are planned test-first under [`docs/test-plans/`](docs/test-plans/): each plan names every test case verbatim and the wrong implementation it rejects, and `scripts/audit/test_plan_check.py` in the yom-spine repo holds plan and suite to each other in both directions.

## Cost & billing

Usage runs on your Claude **subscription**, metered like any Claude Code usage — per token roughly **Fable ≈ 2× Opus ≈ 5× Sonnet ≈ 10× Haiku**, and a higher effort level spends more tokens per turn on the same model — so the default is Sonnet and you opt into Opus, Fable or a higher effort per topic. Heavy use can hit your plan's rate limits (you'll see throttling).

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
- **The Allow/Deny prompt cannot be bypassed by your settings files.** A permissive `~/.claude/settings.json` (an allow rule for `Bash`, say) approves a tool before the SDK's permission callback is ever consulted. telepath registers a PreToolUse hook that forces the prompt for every tool that is not read-only, so the Telegram button is the decision on every machine, whatever the local settings allow. Measured against SDK 0.3.278; `bun run smoke` re-checks it.
- **Keep the group private / solo.** Anyone *in* the forum group can read the bot's output (session content, tool results) even though only you can drive it. Don't add others.
- **Auto mode = remote code execution.** A topic in `/auto` runs tools with no prompt. That's the point, but it means a single Telegram message can run arbitrary commands. It's per-topic, off by default — enable it only for topics/work you trust, and be aware that untrusted content a session fetches (web pages, files) could attempt prompt-injection.
- **Bot token handling.** The `TELEGRAM_BOT_TOKEN` is scrubbed from the environment passed to child sessions (so a prompt-injected session can't read it from *its env*), and `.env` is force-chmod'd to `600` on load. This is **not** a sandbox, though: a session running tools (`Bash`/`Read`) — especially in `/auto` — can still read the `.env` file on disk like any other local file. The real protections are the single-user gate and keeping auto-mode off for untrusted work.
- **Child sessions inherit your environment** (minus the bot token). If you export other secrets (e.g. `ANTHROPIC_API_KEY`, cloud credentials) in the shell that launches the daemon, child sessions can see them — run the daemon from a clean environment if that matters.
- **Auth.** Runs on your `claude login` (subscription). No API key is stored or used.
- **Your responsibility:** keep `.env` private (it's gitignored), keep the bot token secret, and don't expose the group.

## Caveats

- Built on the Agent SDK's `query()` with streaming input, pinned to an exact SDK version; bump deliberately and run `bun run smoke` afterwards.
- **One bot = one instance = one user.** Each teammate runs their own (own bot, own group, own `claude login`).

## License

[MIT](LICENSE).
