# Changelog

## Unreleased

### Added
- **Team mode and session profiles.** `TEAM_MODE=1` opens the forum to all its members, as
  the forum itself reports them: every sender but the configured admins is checked with
  `getChatMember` (a yes cached ten minutes, a no or a failed lookup thirty seconds; a muted
  member is no member; a 400 "user not found" is a no, any other failure is said once as
  "could not verify" rather than dropped in silence; the forum's `chat_member` updates clear
  the cache), so a public forum that lets non-members post is no hole. A post made as the
  group (an anonymous admin) or by a linked channel is dropped, and inside a topic the reason
  is said once. Members chat and open topics (typing in a fresh topic, the 🆕 button, or
  `/new <title>`, capped at 120 UTF-16 units, under Telegram's topic-name limit however it
  counts, so emoji count double; `TEAM_TOPICS_PER_DAY` per member per
  local day, default 20, admins exempt, a refused creation not counted; a topic costs no
  process until someone writes in it). Closing, deleting and wiping a topic, model, effort,
  approvals, settings, the session list, `/attach`, `/status` and wrapping up at the next step stay with `ALLOWED_USER_ID`
  plus `ADMIN_USER_IDS` (numeric ids; an allowlist of member actions in `src/access.ts`, so
  an action it has not heard of is an admin's); a closed topic opens no session for anyone
  until an admin reopens it; the delete and wipe confirmations are their own message in team
  mode, with a Cancel that removes it, so the pinned panel stays everyone's. General is the members' own: commands are answered there,
  chatter and media are not. The published menu is `new`, `menu` and `help`; `/status` in team mode
  is a reduced screen (counts, uptime, the profile's name) safe wherever it is shown.
  Team mode requires the bot to be an admin of the forum with Manage Topics (the boot refuses
  otherwise: topics are created with that right, and the forum's membership changes reach admin
  bots only) and
  `PROFILE_FILE`, a locked session profile (`src/profile.ts`,
  `profile.example.json`): one set of MCP servers and nothing from the machine's own MCP
  config, an explicit tool allowlist (exact names, no patterns) with everything else denied
  and never prompted (`permissionMode: dontAsk` plus a PreToolUse hook of the profile's own,
  since `dontAsk` alone leaves Claude Code's auto-approved built-ins reachable; the approval
  gate hook stays out, as it would deny the allowed MCP tools), no built-in tools unless
  named (none at all in team mode; a kept built-in must be allowed; `AskUserQuestion` is
  refused, since no profile session can prompt), no settings files, a prompt of its own, a
  fixed working directory, `maxTurns` and `maxBudgetUsd` (required in team mode). Every
  server entry is read at boot and a profile with any problem stops the boot with all of
  them listed (a stdio `command` is a bare name, an absolute path, or `./` or `../` against
  the profile's directory, as are such `args`; `~/…` or `bin/x` is refused, since nothing
  expands a `~` and the child's cwd is not the profile's). A profile also works without team mode, for a read-only single-user
  assistant. Under a profile there is no wizard, the pinned panel loses its model, effort
  and approvals buttons (`/auto` and those taps say so; typed `use` and `effort` go to the
  session as text), old sessions are not attached or resumed (a binding made before the
  profile opens a fresh session; a seed request from the todo queue is refused and set aside
  under `seed-requests/refused/`, said in the log), an inbound photo, file or video is answered with a notice
  rather than a host path, a turn or voice note that failed is said without the error
  detail (the log has it), and the budget is enforced per topic across idle stretches: the
  spend is accounted from the running total the SDK reports (increments over the last
  reported total; a transcript that restarted counts whole), each stretch gets what is
  left, a topic at its cap is told so, and a rate-limit or rotation continuation that
  cannot run says why instead of "resuming". A session mid-turn is never paused to free a
  slot for another topic; when every slot is running, the newcomer is asked to send again.
  Voice notes need `TRANSCRIBE_CMD` (nothing is downloaded without it), two are transcribed
  at a time, and the audio is removed once heard. Commands tapped from the group's menu
  (`/new@bot_name`) are read when the handle is this bot's and ignored otherwise; a reply in
  General is General, not a topic. An `ANTHROPIC_API_KEY` in `.env` reaches the Claude Code
  child, for installs that bill a Console organization rather than a login.
- **Video, GIFs and video notes, both ways.** Inbound: videos, GIFs/animations and round video
  notes are now downloaded (under Telegram's 20 MB bot-download cap) and handed to the session
  with the saved path and a frame-extraction hint, where before only photos and documents were
  handled and every other type was silently dropped. Outbound: a file dropped in the outbox is
  routed by type, so a video plays inline (`sendVideo`), a GIF animates (`sendAnimation`) and
  audio gets a player (`sendAudio`), instead of every non-image going out as a document; a typed
  send Telegram rejects for a format outside its inline set (for example `.wav`/`.flac` audio or
  `.mkv`/`.mov` video) falls back to document delivery, so a file is never left stuck in the outbox
  retrying. Routing and the per-kind notices live in a new pure, tested module `src/media.ts`;
  `src/bot.ts` stays the thin Telegram edge. The `message:animation` handler is registered before
  `message:document` because Telegram tags animation messages with a legacy document field the
  document handler would otherwise claim first.
- **Voice notes.** A voice note or audio file sent into a topic is transcribed by `TRANSCRIBE_CMD`
  (new, optional; a command line, arguments allowed), shown as `🎙️ <words>` and handled as typed
  text. A forwarded note or an audio file is passed on as shared content with its caption, not as
  the user's instructions; a voice note in General is refused like a photo. Transcription runs in
  the background with a 3-minute limit and a per-topic queue, so later messages in that topic wait
  for it while no other topic is held up; every failure, an unset `TRANSCRIBE_CMD` included, is
  answered in the topic. The transcriber runs without anything `.env` holds. The pre-0.2.0 fork had this; the rewrite dropped it and voice notes were
  ignored without a trace.

## 0.2.0 — 2026-09-22

Rewrite on the current Agent SDK, in tested modules, with observability.

### Changed
- **Agent SDK 0.2.117 → 0.3.278.** Sessions run on `query()` with streaming input (a
  per-topic mailbox keeps the process resident) instead of the removed `unstable_v2_*`
  API. The SDK bundles Claude Code 2.1.278, so the Claude 5 models work without a
  `CLAUDE_BINARY` override, and effort is the SDK's `effort` option rather than an
  environment variable smuggled into the child process.
- **`daemon.ts` is a bootstrap; behaviour lives in `src/`.** Config parsing, state,
  the pump's interpretation of SDK messages, the wizard, the typed-command grammar,
  keyboards, eviction and the rate-limit/rotation logic are pure modules with 117 tests
  that run without a network, a token or a claude process. `tsconfig.json` with Bun types
  makes `bun run typecheck` a real gate.
- **Idle eviction works.** The previous `pumping` flag was true for a session's whole
  life, so idle sessions were never evicted; a session is now idle when no turn is in
  flight and nothing happened for `IDLE_MINUTES`.
- **A live status message per turn.** `⏳ Working · 1:42 · 9 tool calls`, edited in place
  at most every 12 s and only when changed, typing indicator alongside, queue count when
  more messages arrive, the rate-limit wait while it holds, and a one-line summary (or
  nothing, for a short quiet turn) when the turn ends. It stays the last message of the
  topic: content posted below it moves it to the bottom, once per burst. All status
  operations across all topics share one budget (12/min; Telegram's ~20/min limit is per
  group, and topics share a group), the interval stretches with the number of active
  topics, typing slows above three, and grammy's `auto-retry` waits out any 429 on any
  API call. Answers stay new messages because an edit sends no notification. Commands
  shown in it are masked for well-known secret shapes (bearer headers, `KEY=value`
  credentials, token prefixes, a bot token in a URL).
- **The activity feed is a digest** inside that status message. About every 15 seconds, and before any text or task
  completion so chronology holds: commands, subagents and task starts by their
  description, edits collapsed to one counted line, reads and searches as a count. The
  first version's one message per tool call read as spam on a phone (file names of a
  machine the reader cannot reach, one message per edit) and let "done" arrive before
  "started". Task starts and completions come from the SDK's own events.
- **Configuration errors are reported together**, not one restart at a time; an unknown
  `DEFAULT_EFFORT` or `LOG_LEVEL` is an error rather than a silent default.

### Fixed
- **Approvals could be bypassed by the machine's own settings.** An allow rule in
  `~/.claude/settings.json` (or a bare `allowedTools` entry) approved a tool before the
  SDK's `canUseTool` callback ran, so on such a machine every command executed with no
  Telegram prompt. A PreToolUse hook now forces the prompt for every non-read-only tool;
  `allowedTools` is no longer passed. Found by the new Ring 2 smoke.
- The outbox contract was also registered as a SessionStart hook that never ran under the
  SDK; the first-prompt priming (which did) is now the only channel.
- **⏹ Wrap up** on the status message (or type `wrap up` / `stop`): a steering message
  with SDK priority `now` (or `next` for "finish this turn first") asks the session to
  finish its current step, write a hand-off (Done · Open · Resume) and stop; the hand-off
  is stored and **▶️ Resume** sends it back as the next message. Nothing is interrupted
  mid-step and the transcript keeps the context.
- A session is busy from a turn's `init` to its `result`, and messages sent mid-turn are
  counted as folded into that turn (measured: the CLI answers them with its one result).
  The former per-message count drifted upward by one per folded message, so a session
  that had answered everything still read `9 messages queued` and never went idle.
- The digest lists the most recent lines, not the first five frozen for the whole turn;
  a background command no longer appears twice (tool call + task start); edited files
  are named newest first; and the header says `last action 3m ago` once the session has
  been quiet for 30 s.
- Status budget hardening: every status operation (create, edit, both halves of a
  move, the closing summary and its retries) reserves budget first and is deferred, never
  skipped past, when the budget is full; ticks are serialized so a slow API call cannot
  double an edit; the user's own message moves the status below it; a rate-limit wait
  clears when the next queued turn runs; a deleted topic cancels its pending summary;
  "edited N files" counts distinct files; model-written descriptions are redacted too,
  and redaction requires `=`/`:` after a keyword so prose like "the auth routes" is left alone.
- `/attach` and the sessions list refuse an ambiguous prefix instead of
  binding the first match; a registry that does not parse stops the boot (exit 2) and is
  never overwritten; the unformatted fallback is split as plain text; `use <key>` and the
  panel refuse packages outside `ENABLED_MODELS`; an oversized feed burst is sent as
  several messages; closing a session drops its queued prompts; the rotation baseline is
  read before the rotator is spawned; the 🗑 delete prompt no longer claims the transcript
  is gone. The SDK's peer
  dependency `@anthropic-ai/sdk` is now pinned to a version it accepts.

### Added
- Structured JSON-lines logging (`LOG_LEVEL`, `LOG_FORMAT`), per-process counters, a
  bounded ring of recent errors, 📊 Status / `/status`, and `health.json` rewritten every
  minute.
- Boot preflight: claude binary version against the minimum the current models need,
  and the bot's identity before polling starts (exit code 2 for bad config, 3 for a
  Telegram failure).
- `scripts/smoke-session.ts` (`bun run smoke`): Ring 2 for the session layer — text
  turn, tool deny through `canUseTool`, SessionStart hook context, session id capture,
  resume by id.
- `docs/test-plans/query-api-rewrite.md`: the plan every test above is named in.

### Removed
- The `CLAUDE_BINARY` workaround documentation (the option remains as an override).
- The `CLAUDE_CODE_EFFORT_LEVEL` env-var path for effort.

## 0.1.x

Model packages (Haiku/Sonnet/Opus/Fable) and per-topic effort levels; activity feed;
rotator hand-off and rotation resume; readable table rendering with a render deadline;
Windows install and start scripts.
