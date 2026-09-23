---
feature: telepath runs on the current Agent SDK, in modules whose logic is tested without Telegram or a claude process, and reports what it is doing
suite:
  - src/config.test.ts
  - src/models.test.ts
  - src/state.test.ts
  - src/log.test.ts
  - src/feed.test.ts
  - src/interpret.test.ts
  - src/mailbox.test.ts
  - src/topics.test.ts
  - src/ui/keyboards.test.ts
  - src/ui/wizard.test.ts
  - src/commands.test.ts
  - src/preflight.test.ts
  - src/gate.test.ts
  - src/status.test.ts
  - src/handoff.test.ts
  - src/rotator.test.ts
gate: bun test
---

# Rewrite on the query() API, in testable modules

## Premise

The request: make telepath professional end to end, no patches. What was checked, and
what turned out false or true:

- **True: the daemon runs on a removed API.** `daemon.ts` imports `unstable_v2_createSession`
  / `unstable_v2_resumeSession` from `@anthropic-ai/claude-agent-sdk@0.2.117`. The current
  release (0.3.278, checked by unpacking the tarball and grepping `sdk.d.ts`) exports no
  `unstable_v2_*` symbol at all. The supported shape is `query({ prompt: AsyncIterable<SDKUserMessage>, options })`,
  which stays resident while the iterable is open, with `resume`, `effort`, `canUseTool`,
  `hooks`, `settingSources`, `permissionMode`, `env` and `cwd` as first-class options.
- **True: two of the current features are workarounds for that API.** `CLAUDE_BINARY`
  points at a VS Code extension's binary because the pinned SDK bundles Claude Code 2.1.117,
  which the Claude 5 models refuse (`claude_code_version_too_old`); and effort travels as
  `CLAUDE_CODE_EFFORT_LEVEL` in the child environment because `SDKSessionOptions` had no
  `effort`. Both disappear with the upgrade: the SDK bundles 2.1.278 and `effort` is an
  option.
- **False: "the daemon drops assistant text."** Profiled the webshopNick transcript
  (`~/.claude/projects/C--Bots-webshopNick/d937ef24….jsonl`, 6618 entries): between 04:00 and
  05:00 the model made 277 tool calls and wrote one text block. The daemon forwarded what
  existed. What the user lost was the approval prompts, which are the only per-tool
  visibility and vanish in auto mode. The activity feed (`feed.ts`) is the deterministic
  replacement; this plan carries it into the new structure and adds the SDK's own task
  events to it.
- **True: nothing in the daemon is testable.** One 1776-line module creates the bot at
  import time, exits the process when a setting is missing, and interleaves Telegram calls
  with the logic that decides them. The existing suites cover the two pure corners that were
  extracted (`markdown.ts`, `rotator.ts`, `feed.ts`); the pump, the registry, the wizard, the
  command parsing, the eviction and rate-limit logic have no test. That is the structural
  reason every earlier fix here was verified by hand.
- **True: there is no observability.** Diagnostics are `process.stderr.write` strings with
  no level, no structure and no counters. The user discovers a silent failure by noticing
  silence. The four questions asked in this session (is text being dropped, is the binary
  too old, is a session live, why did the turn end) each needed a transcript or a process
  list to answer.
- **Checked and kept:** the existing behaviours are the contract. Topic per session,
  Allow/Deny prompts as buttons, clarifying questions as options, plan approval, auto mode,
  idle eviction and the live-session cap, rate-limit auto-resume, rotator hand-off and
  rotation resume, outbox delivery and inbox for photos and documents, close/delete/wipe,
  the pinned control panel, the wizard, and the markdown rendering. Every one is preserved;
  the rewrite changes where they live and how they are verified.
- **Decided, not measured:** a model or effort switch keeps the existing close-and-resume
  design rather than using `Query.setModel()` mid-session. One code path, and the takeover
  logic already exists for it. Revisit if the restart cost is felt.
- **False, found by the Ring 2 smoke against SDK 0.3.278: "`canUseTool` is the permission
  gate."** With the machine's `~/.claude/settings.json` allowing `Bash`, a session ran
  `echo smoke` and the callback was never invoked (`denied=0`). The SDK itself warns that
  bare `allowedTools` entries and settings allow rules approve a tool before the callback
  is consulted. A PreToolUse hook answering `permissionDecision: 'ask'` forces the prompt,
  which in SDK mode is the callback: measured, the same request then reached `canUseTool`
  and the deny was honoured. The gate is therefore two halves (`src/gate.ts` + the
  callback), and `allowedTools` is not passed at all so one gate sees every call.
- **False, found by the same smoke: "the SessionStart hook delivers the outbox
  contract."** With `includeHookEvents` on, a PreToolUse callback ran and a SessionStart
  callback registered the same way never did; the model answered with its own scratchpad
  path. The old daemon's comment ("not reliably plumbed") still holds, so the contract is
  prepended to the topic's first prompt (which was already the guaranteed channel) and the
  hook is gone rather than kept as decoration. The smoke now tests the channel the daemon
  actually uses.
- **Found by Copilot's review of the first push (nine findings, all confirmed against the
  code):** a `/attach` prefix bound the first of several matches; a registry that failed to
  parse was overwritten with `{}` (my own boot-time "repair"); the unformatted fallback went
  through the HTML-aware splitter, which reads `<…>` as tags; `use haiku` switched to a
  package the config had disabled; an oversized feed burst was truncated at the tail; a
  closed mailbox still drained queued prompts; the rotation baseline was read after the
  hand-off had spawned the rotator (the same race fixed in PR #6, reintroduced by event
  ordering); a boolean `busy` let a queued second turn be evicted as idle; and the 🗑 delete
  prompt claimed permanence the operation does not have. Each has a case below or a
  wording fix, and the SDK's peer dependency `@anthropic-ai/sdk >=0.93.0` was unmet by the
  lockfile (0.81.0) and is now a direct dependency.
- **False, found on the phone after the first evening: "one line per tool call is
  readable."** Screenshot 22 Sep 19:48: each Write arrived as its own message (calls come
  seconds apart, so a 2.5 s window batches nothing), the names were files on a machine the
  reader cannot reach, and "✅ done" preceded "🤖 started" because completions were sent at
  once while starts waited in the batch. The feed is now a digest: commands, subagents and
  task lines by description, edits as one counted line, reads as a count, a 15 s window,
  flushed before any text or completion so chronology holds.
- **Requested after the digest: "a loading bar so I know Claude is busy."** Two Telegram
  facts decide the shape. An edit sends no notification, so the answer can never be an
  edit of the working message: answers, questions and approvals stay new messages and the
  status only reports progress. And edits are throttled, so one message per turn is edited
  at most every 12 s, only when its text changed, with the exact `retry_after` honoured
  on a 429. No percentage is shown because none exists for open-ended agentic work:
  elapsed time, tool-call count and the digest are honest; the spinner frame changes so
  the message visibly lives. The typing indicator runs alongside while a turn is in
  flight. A short turn with nothing done leaves no message behind. Commands shown in the
  status are redacted for well-known secret shapes, because the message is edited and
  stays visible. The core is transport-agnostic (create/edit/remove/type), the same three
  calls Slack and Discord offer.
- **Asked after the first evening with the status: "does this hit rate limits with several
  topics, and why is the timer buried above the answers?"** Telegram's limit of about
  twenty operations a minute is per GROUP, and every topic is a thread of one group, so
  five topics at one edit per 12 s would already exceed it on their own. All status
  operations now draw from one shared budget (12/min by default, the rest is left for real
  messages), the per-topic interval stretches with the number of active topics, typing
  halves above three topics, and grammy's `auto-retry` waits out any 429 the bot still
  meets instead of dropping the call. A message cannot be moved on Telegram, so when
  something is posted below the status it is deleted and re-posted silently at the bottom,
  once per burst; a turn's verdict is posted at the bottom too when content arrived after
  the last move. The last message in a topic is therefore the timer or the verdict.
- **Seen on the phone after a two-hour turn: "it keeps saying the same thing."** The digest
  listed the FIRST five commands with "+128 more", every background command appeared twice
  (its tool call and the SDK's `task_started` for it), and nothing in the header said when
  the last action was. The digest now lists the most recent lines behind an "N earlier"
  count, drops a task start that repeats a listed command, names the newest edited files
  first, and the header carries "last action 3m ago" once the session has been quiet for
  30 s, which is the one line that separates thinking from stuck.
- **Asked: "a Stop button — but doesn't he forget what he was doing?"** A hard
  `interrupt()` drops the step in flight and leaves the user to reconstruct where things
  stood. Measured against SDK 0.3.278 with a strictly sequential eight-step chain: a user
  message with `priority: 'now'` ends the running turn at its next step boundary (its own
  result first) and runs immediately after; `'next'` runs after the current turn; both run
  before messages queued plainly (order measured: now → next → plain). So Wrap up is a
  steering message, not an interrupt: finish only the step you are on, start nothing new,
  write Done/Open/Resume, stop. The hand-off is parsed and stored on the binding, ▶️
  Resume sends it back, and the queue runs afterwards unless the user chooses to drop it
  (the session is then closed after the hand-off, and the count is reported).
- **Found by Copilot's review of the wrap-up (two inline findings, both taken):** a wrap-up
  did not count as a takeover, so a rate-limit nudge scheduled before it, or a rotation
  landing after it, could restart the work behind the hand-off or reopen a dropped
  session; and the summary edit left the keyboard to an omitted field, now cleared
  explicitly. Two remarks in its file table were read against the code and kept as they
  are: a hand-off with only a Resume paragraph is still resumable, so Done/Open stay
  optional; and a `started:` line is dropped only when its command is listed in the same
  digest, which is the dedupe wanted, not a recency bug.
- **Found by Copilot's third round (nine findings, all confirmed):** overlapping ticks could
  double an edit; a model-written description escaped redaction; "edited 5 files: a.ts"
  counted calls, not files; the user's own message buried the status without a move;
  `begin()`, the final edit and its retries ignored the budget's answer; a move spent two
  operations on one reservation; a rate-limit wait survived into the next queued turn;
  and a deleted topic kept retrying its summary. Each has a case below; the rule that
  came out of it is that EVERY transport operation reserves budget first and what the
  budget refuses is owed, never skipped past.
- **Found by Copilot's review of the status push (five findings, all confirmed):** an old
  pump's unconditional `idle` closed a replacement session's fresh status as "stopped"
  after a model switch; a status spanning queued turns summarized an early failure as
  "Done" when the last turn succeeded; feed-off turns produced no items, so the status
  counted zero tool calls and could delete a busy turn's message as "quiet"; a rejection
  without a reset time never showed the paused header; and a 429 on the final summary edit
  left "Working" behind forever. Each has a case below.
- **Found by the same smoke: breaking out of `for await` on the stream ends the session.**
  Returning the SDK's generator closes the query. The daemon's pump never breaks; the smoke
  script now mirrors it with one reader per session.

## Architecture

```
daemon.ts             bootstrap only: config → log → state → preflight → backend → topics → bot
src/config.ts         .env parsing and validation into a typed Config; every error at once
src/models.ts         model packages, effort levels, labels
src/state.ts          registry.json / prefs.json, atomic writes, migration at load
src/log.ts            structured JSON-lines logger, counters, error ring, health snapshot
src/mailbox.ts        push-based AsyncIterable that keeps a query() resident
src/session.ts        the only module that imports SDK runtime: query(), listSessions()
src/interpret.ts      SDKMessage → typed events (pure; the pump's decisions)
src/feed.ts           tool-call items, secret redaction, the digest (pure)
src/status.ts         one live status message per turn: elapsed, digest, queue; edits rate-limited (pure core)
src/handoff.ts        wrap-up: the instruction, the hand-off shape and its parser, the resume prompt (pure)
src/topics.ts         live sessions, cap, idle eviction, rate-limit resume, rotation watch
src/commands.ts       typed-text command grammar (pure)
src/ui/keyboards.ts   every keyboard and panel text (pure)
src/ui/wizard.ts      the new-session wizard as a state machine (pure)
src/bot.ts            grammy handlers: the glue between Telegram and the modules above
src/files.ts          outbox / inbox / transcript removal
src/preflight.ts      boot checks: binary version, Telegram identity, state dir
src/markdown.ts       unchanged, moved; render-worker.ts beside it
src/rotator.ts        unchanged, moved
scripts/smoke-session.ts  Ring 2: one real session against the SDK, no Telegram
```

Dependency rule: only `src/bot.ts` talks to the Telegram API (`src/ui/keyboards.ts` uses
grammy's `InlineKeyboard` as a data builder, nothing more); only `src/session.ts` imports
SDK runtime values (other modules import SDK *types* only). Everything under test runs
without a network, a bot token or a claude binary.

Observability: every log line is one JSON object (`ts`, `lvl`, `ev`, fields; `LOG_LEVEL`
filters, `LOG_FORMAT=pretty` for a terminal), counters accumulate per process, the last
twenty errors are kept, and all three are readable from the phone (📊 Status / `/status`)
and from disk (`health.json`, rewritten every minute). Boot runs a preflight: the claude
binary's version against the minimum the current models need, and the bot's identity.

## Cases

| Case | Asserts | Mutant it kills |
|---|---|---|
| `parses KEY=value lines and ignores comments and blanks` | the .env reader yields exactly the assignments, trimmed, and skips `#` lines and empty lines | a split on `=` that keeps the comment text as a value |
| `does not overwrite a variable the shell already set` | a key present in the process environment wins over the file | the file clobbering the shell, so a per-run override is impossible |
| `reports every missing required setting at once, not just the first` | three missing settings produce one error naming all three | exiting on the first missing key, so the user fixes them one restart at a time |
| `rejects an effort level it does not know` | `DEFAULT_EFFORT=turbo` is a configuration error, not a silent default | `parseEffort` returning undefined and the boot proceeding with no effort |
| `applies defaults for optional settings` | idle minutes, cap, model ids and log level take their documented defaults when unset | a required-everything config that a fresh clone cannot boot |
| `keeps only enabled models it knows and never ends with none` | `ENABLED_MODELS=fable,unicorn` yields `[fable]`; an all-garbage list yields the fallback | an empty menu when the list is mistyped |
| `falls back to the first enabled model when the default is disabled` | `DEFAULT_MODEL` pointing at a disabled package resolves to the first enabled one | booting with a default the menus cannot show |
| `a known package that is not enabled is refused where a switch is requested` | `isEnabledModelKey` is false for a known key outside `ENABLED_MODELS`; the wizard, the panel, Settings and `use` all consult it | accepting any known key, so a disabled model a plan cannot reach is selectable |
| `parses the five effort levels case-insensitively and nothing else` | `LOW`…`max` parse; `""`, `turbo`, `default` do not | a comparison that accepts any string |
| `haiku accepts no effort level, the other packages accept all five` | `supportsEffort` is false for haiku and true for sonnet, opus, fable | sending an effort the model rejects |
| `a binding on a model without effort levels runs without one but keeps its choice` | `effortFor` is undefined for a Haiku binding whose stored effort is `max`; the stored value survives a switch back | clearing the stored effort on a model switch |
| `persists a cleared default effort as null so it survives a restart` | clearing the default writes an explicit null and reloading yields no effort even with `DEFAULT_EFFORT` set | `JSON.stringify` dropping the undefined key so the .env default returns on boot |
| `an absent effort key falls back to the configured default` | a prefs file from before the field existed inherits `DEFAULT_EFFORT` | treating absence as a deliberate clear |
| `drops a garbage effort value from an old prefs file` | `defaultEffort: "turbo"` on disk loads as undefined | trusting the file over the parser |
| `refuses to start on a malformed registry instead of overwriting it` | a registry that does not parse throws `StateError` and the file is untouched; a missing file starts empty | treating "could not parse" as "empty" and saving `{}` over every binding |
| `writes atomically through a temp file and rename` | after save the final file holds the new content and no temp file remains | writing in place, which a crash mid-write turns into a truncated registry |
| `migrates bindings off a disabled model at load` | a binding on a model no longer enabled is moved to the default and the store is marked dirty | a topic that keeps failing on a model the plan cannot reach |
| `emits one JSON line per event with ts, level, event and fields` | a log call produces parseable JSON carrying exactly those keys | free-form strings that nothing can filter or count |
| `filters below the configured level` | at level `warn`, `info` and `debug` events are not written | a level that is stored but never consulted |
| `counters increment and snapshot` | `inc` twice reads 2 in the snapshot; unknown names start at 0 | a snapshot that returns live references the caller can corrupt |
| `keeps the last errors in a bounded ring` | after 30 errors the ring holds the newest 20 in order | an unbounded array that grows for the process lifetime |
| `Bash prefers the human description over the command` | the feed line shows the description when present | showing raw commands the phone cannot read |
| `Bash without a description shows the command, trimmed to one line` | newlines collapse, length is capped | a multi-line command spilling over the feed |
| `background Bash is marked, so a later "done" line has a referent` | `run_in_background` sets the item's background flag, rendered as ⏳ | a completion notice with nothing it can refer to |
| `file tools name the file, not the whole payload` | Read/Edit/Write show the basename only | dumping `old_string`/`content` into the chat |
| `search tools show the pattern` | Grep and Glob show the pattern | a bare tool name |
| `subagents show their brief` | Agent shows its description | the full prompt |
| `unknown tools fall back to name plus a short input` | an MCP tool yields `🔧 name {…}` within the cap | throwing on an unknown name |
| `every label is single-line and capped` | class-level: no item label contains a newline or exceeds the cap | a cap applied before the newline collapse |
| `turns an assistant message into one item per tool call, nothing for text or thinking` | `feedItems` yields one item per `tool_use` block, marked `sub` for a subagent | counting text blocks as activity |
| `a digest lists commands and subagents, collapses edits into one line and counts reads` | commands, subagents and web calls keep a line each in call order; edits become one counted line of DISTINCT files; reads and searches are a count | one message per file the machine touched, or "edited 5 files: a.ts" for five edits to one file |
| `labels never leak obvious secrets` | bearer headers, `KEY=value` credentials, known token prefixes and a bot token in a URL are masked in command labels AND in the model's own descriptions and briefs; a git sha is not | showing commands verbatim, or trusting the description because it is prose while it echoes the command's credential |
| `a digest never lists more than a handful of lines and says how many it left out` | at most five listed lines, the MOST RECENT ones, behind an `… N earlier` line | a burst of thirty commands as thirty lines, or the first five frozen for two hours |
| `a digest shows the most recent activity and drops a task start that duplicates its command` | the last five listed lines are shown, edits name the newest files first, and a `started:` line that repeats a listed command is dropped | showing the oldest lines forever, and every background command twice |
| `the header says how long ago the last action was once the session goes quiet` | after 30 s without a tool call the header carries `last action Ns ago`, in s/m/h; nothing before the first action | a two-hour turn whose header cannot tell thinking from stuck |
| `a message without tool calls yields no items` | text-only and undefined content yield `[]` | a placeholder item for every message |
| `describes a started background task and a settled one` | `task_started` with `is_backgrounded` and `task_notification` each yield one line carrying status and description | showing only completions, so a start is invisible |
| `assistant text becomes one say event` | text blocks in one message concatenate into a single say | one message per block |
| `tool calls become feed items and subagent calls are marked` | items are emitted for every tool call whatever the display toggle; `parent_tool_use_id` set yields items flagged `sub`, rendered with ↳ | gating the items on the toggle, so a feed-off turn counts zero tool calls and its status is deleted as quiet |
| `captures the session id on the first assistant or result, never on init` | the id event fires once, only after a turn produced output | saving an id from `init` for a session closed before its first turn, which then fails every resume |
| `a rejected rate limit yields one rate-limit event and later allowed events yield none` | status `rejected` → one hit event ordered BEFORE the relay, so the rotation baseline is read before the hand-off spawns the rotator; `allowed`/`allowed_warning` → relay only | alerting on every status change, or relaying first and reading a baseline the rotator has already moved |
| `resets the rate-limit alert at the end of the turn` | after a `result`, the next `rejected` alerts again | a flag that stays set and silences every later turn |
| `a non-success result yields a turn-error event and success yields a quiet turn-end` | `error_during_execution` → error event with the subtype; `success` → turn-end only | a notice on every turn, or none on failures |
| `a background task notice carries status and summary` | `task_notification` yields status and summary verbatim | dropping the summary the user needs to tell tasks apart |
| `a task_started event announces a background task once` | `task_started` yields one task event with its description and whether it runs in the background | announcing only completions, so a start is invisible |
| `permission_denied surfaces as a notice` | the tool name and message reach the user | a silent denial the model works around |
| `delivers pushed messages in order to a single consumer` | three pushes are read as three items in order | a Set or a map that reorders |
| `waits for the next push instead of ending` | with the queue empty, `next()` stays pending until a push | returning `done` on an empty queue, which ends the session |
| `ends the iteration when closed and rejects pushes after close` | `close()` resolves the pending `next()` as done; a later push throws | a push into a closed mailbox that is silently lost |
| `drops queued items on close instead of draining them afterwards` | after `close()`, a previously pushed item is never yielded | checking the queue before the closed flag |
| `wraps text as a user message with parent_tool_use_id null` | `userMessage(text)` has the exact shape the SDK types require | a message the CLI rejects as malformed |
| `opens a session on first message and reuses it while live` | two messages open one backend session | a new process per message |
| `evicts the least recently active session when the cap is reached and tells that topic` | the oldest topic is closed and notified; the new one opens | evicting the newest, or evicting silently |
| `evicts idle sessions and leaves a session mid-turn alone` | idle past the limit closes; a turn in flight protects the session, and a second message queued during a turn keeps it busy until its own result | a boolean that the first result clears while a queued turn still runs |
| `a model or effort switch closes the live session so the next message resumes with the new options` | after the switch the backend sees a new open with the new model and effort | a live process that keeps the old model until eviction |
| `resumes with the recorded session id and records it once produced` | `open` receives `resume` when the binding has an id; the id from the stream is stored | a resume that starts a blank session |
| `schedules a resume nudge for a usable resetsAt and cancels it when the user takes over` | a future reset schedules; a user message cancels | a nudge that fires into a topic the user already continued |
| `a rotation with the topic untouched closes the session and continues` | with no takeover, the session closes and a continuation is sent | waiting out a reset the rotator already solved |
| `a stale rate-limit alert does not suppress the next turn's error notice` | an error in the turn after a rejection is reported | a per-session flag that never resets |
| `a stale pump does not report idle once a replacement session is live` | an old stream ending while a replacement runs emits no idle; the replacement's own end does | closing the new session's status as stopped from the old pump's finally |
| `emits turn start and end with the number of turns in flight` | `turn/start` per send with the count, `turn/end` per result with the count after decrement and the outcome, `turn/waiting` on a rejection | a status that cannot tell one running turn from three queued ones |
| `pinned controls show only enabled models and mark the current one` | buttons for enabled keys only, ✓ on the binding's model | every key in the catalog, or no mark |
| `effort rows appear only for models with effort levels` | no effort row for a Haiku binding | sending Haiku an effort |
| `the activity feed toggle reflects the effective default in auto and approvals` | auto with no explicit choice reads ON; approvals reads OFF | a label that reads the raw undefined flag |
| `pages a long list two per row with prev and next only where they lead somewhere` | page 0 has Next only, the last page has Prev only | arrows that lead off the ends |
| `callback data never exceeds telegram's 64-byte limit` | class-level: every callback string produced by every builder is under 64 bytes | a long model id in callback data that Telegram rejects |
| `folder then model then effort then approvals for a model with effort levels` | the transitions run in that order and finish with all four choices | skipping effort for every model |
| `skips the effort step for a model without effort levels` | Haiku goes from model to approvals | a Haiku session created with an effort |
| `back from the effort step returns to the model step keeping the folder` | the folder survives the back step | restarting the wizard |
| `default effort in the wizard means the settings default` | choosing default leaves the wizard's effort unset so the caller applies prefs | writing `undefined` over a configured default |
| `use with a model and optional effort` | `use fable high` → model fable, effort high; `use opus` → no effort | a grammar that needs both |
| `effort default clears` | `effort default` → effort undefined; `effort max` → max | treating `default` as an unknown level |
| `feed on and off` | `feed on`/`feed off` parse case-insensitively | a toggle with no explicit state |
| `slash commands with args` | `/new x cwd=/p auto` → command `new` with the raw args | splitting args the command cannot rejoin |
| `plain text is chat` | anything else is a chat message | a grammar that swallows ordinary sentences |
| `forces the permission callback for every tool that is not read-only` | the PreToolUse decision is `ask` for Bash, Write, Web, Agent, questions, plans and MCP tools | relying on settings allow rules or `allowedTools`, which approve before any callback |
| `lets read-only tools through without a prompt` | Read/Glob/Grep/LS/NotebookRead/TodoWrite pass with an empty hook output; the list is exactly the documented one | a write tool slipping into the auto-allow list |
| `the status text shows elapsed time, tool lines and queued messages` | header with spinner, elapsed, tool-call count and queue; the digest below; a rate-limit wait replaces the spinner; never longer than one message | a fake percentage bar, or a text that outgrows 4096 characters |
| `begin posts one working message and edits it at most once per interval` | one create per turn; the first edit after the short delay; further edits at most every interval even when news arrives sooner; a second begin creates nothing | an edit per tool call, which Telegram throttles |
| `edits back off after a 429 and resume when the retry-after has passed` | a 429 with retry-after suspends edits for exactly that long | retrying every tick into a flood ban |
| `typing indicator is refreshed only while a turn is in flight` | typing actions while active, none after finish | a typing loop that outlives the turn |
| `finish edits the message into a summary, or deletes it after a short quiet turn` | a long turn ends as `✅ Done · time · calls · files`; a short turn with no tool call is deleted; an error ends as a warning | a "Working" message left behind under every answer |
| `a stopped session finishes the status even without a result` | closing a session mid-turn closes its status as stopped | a status stuck on "Working" forever after a model switch or eviction |
| `a rate limit shows as waiting in the status` | the header reads paused while the limit holds, with the reset time when known and without it otherwise; the summary keeps it | a truthiness check on the note, so a rejection without `resetsAt` keeps spinning |
| `an earlier failure in a queued run is not summarized as done` | the most severe outcome across the queued turns wins the summary; an explicit stop still reads stopped | the last turn's outcome overwriting an earlier error or rate limit |
| `the closing summary is retried after a 429 until it lands` | a throttled final edit is retried from the tick after the retry-after and then forgotten | discarding the final edit's result and leaving "Working" behind |
| `the status moves below new messages so the last message in a topic is always the timer` | after content is posted the status is deleted and re-posted at the bottom, once per burst (debounced), carrying its text; later edits go to the new message; a finish right after a post puts the verdict at the bottom | a status buried under the answers, which tells the reader nothing about whether Claude is still busy |
| `edits across all topics share one budget and slow down as topics multiply` | with N active topics no more than the shared per-minute budget is spent — creates, edits, and both operations of a move counted — every topic still gets edits, and the per-topic interval stretches to fit | per-topic intervals that add up past the per-group limit, or a move that reserves one slot and spends two |
| `typing slows down when many topics are active` | the typing cadence halves above three active topics and never stops | a typing loop per topic that scales linearly into Telegram's limits |
| `a rate-limit wait is cleared when the next queued turn starts running` | when a limited turn ends with more queued, the header returns to Working while the run's verdict still records the limit | a paused header shown throughout a turn that is in fact running |
| `ticks never overlap, so a slow edit is not doubled` | a tick still awaiting the API makes the next tick return at once; one edit, not two | overlapping intervals each firing the same due edit |
| `a status is not posted while the budget is exhausted and is posted once it frees` | a begin() the budget refuses is owed to a later tick; a status never posted finishes with no API call | creating past the cap because the budget's answer was discarded |
| `drop cancels a pending closing for that topic` | deleting a topic forgets its queued summary edit | ten retries against a topic that no longer exists |
| `queued messages are counted while a turn runs and the count falls as results arrive` | `N messages queued` while more than one turn is in flight; gone at one | a user unsure whether a second message was taken |
| `parses the hand-off block into done, open and resume` | the three labelled sections are extracted, with or without markdown bold, Resume may span lines | a resume button that sends the whole chat or nothing |
| `text without a resume paragraph is not a hand-off` | no Resume → undefined, so nothing is stored or offered | remembering "All done" as something to resume from |
| `the resume prompt carries the hand-off verbatim and the wrap-up prompt asks for that exact shape` | the prompt the model gets names Done/Open/Resume and "finish only the step"; the resume prompt contains the hand-off | a prompt whose shape the parser cannot read back |
| `wrap up and stop are commands` | `wrap up`, `wrapup`, `stop` alone are the wrap command; a sentence containing stop is chat | "stop the server please" ending the session |
| `a wrap-up sends the hand-off instruction ahead of the queue and marks the next result as wrapped` | the instruction goes with priority `now` (or `next` for after-turn), one wrap-up at a time, nothing to wrap when idle; the preempted turn's result is `ok`, the hand-off turn's result is `wrapped`, queued messages keep running | queuing the instruction behind five messages, or reporting the preempted turn as the wrap-up |
| `a wrap-up that drops the queue closes the session after the hand-off and says how many were dropped` | with drop, the session closes once the hand-off arrived and the event carries the count | dropping before the hand-off, or dropping silently |
| `a wrap-up cancels a pending rate-limit nudge and rotation watch` | a wrap-up counts as a takeover: the reset nudge scheduled by an earlier rejection never fires and a rotation landing afterwards neither closes the session nor injects a continuation | work restarting after the hand-off, or a dropped session reopened by a timer nobody remembers |
| `a hand-off in the model's text is remembered for resume` | a hand-off block in any answer is stored on the binding; ordinary text does not overwrite it | Resume with nothing to send |
| `a wrapped-up turn ends with its own summary` | the verdict reads Wrapped up whatever earlier turns did; the live text carries the button kind, the summary does not | a wrap-up summarized as an error, or a summary still carrying a Wrap up button |
| `the wrap-up confirmation offers the drop option only when something is queued` | no drop button at zero queued; the count in the label | offering to drop nothing |
| `compares dotted versions numerically` | `2.1.278 > 2.1.99 > 2.0.1000` | a string comparison |
| `flags a binary older than the minimum` | 2.1.117 against minimum 2.1.251 is a failure with both numbers in the message | a boot that proceeds to the first 400 |
| `UTC stamp to whole seconds, one space, the raw JSON` | the limit-events line matches the shim's format | a line the rotator dashboard cannot parse |
| `honours env set after the module was imported` | the rotator switch reads the environment at call time | a module constant frozen before .env loads |
| `no script at the configured path means no rotator` | a missing script disables the hand-off | spawning a python that does not exist on every event |
| `returns the new account once .active changes` | the watch resolves with the changed marker | resolving on an unchanged marker |
| `gives up when nothing changes within the attempts` | undefined after the attempts | waiting forever |
| `a missing marker is not a rotation` | undefined stays undefined | treating absence as a switch |
| `no marker before, one after, is a switch` | undefined → account resolves | requiring a previous value |

### Negative cases

| Case | Must not happen | Mutant it kills |
|---|---|---|
| `does not let a prototype name pass as a model key` | `constructor` or `__proto__` accepted as a model key anywhere a key is looked up | `in MODELS` instead of an own-property check |
| `does not repeat the rate-limit alert twice in one turn` | a second `rejected` in the same turn producing a second alert and a second rotation watch | a per-message alert with no latch |
| `unknown message types yield nothing` | `stream_event`, `status`, `tool_use_summary` or an unknown type reaching the chat as text | a default branch that stringifies the message |
| `never leaks the bot token into a session environment` | `TELEGRAM_BOT_TOKEN` present in the environment handed to any session | spreading `process.env` unfiltered |
| `a rotation while the user took over does not interrupt the topic` | the user's live turn closed and a continuation injected after they already continued | a watch that ignores the takeover generation |
| `an unknown model key is refused and leaves the state unchanged` | forged callback data advancing the wizard or finishing it before a folder is chosen | accepting any key, or finishing from any step |
| `prototype names are not commands` | `use constructor` or `use __proto__` treated as a model switch | `in` on the catalog |

## Out of scope

- **Telegram itself.** `src/bot.ts` is glue over grammy and is verified at Ring 2 by
  restarting and using the bot. Its decisions are all in tested modules; what remains is
  API plumbing that a fake would only mirror.
- **The claude process.** `src/session.ts` wraps `query()` and is verified by
  `scripts/smoke-session.ts` against the real SDK, because a fake SDK would test the fake.
- **`Query.setModel()` for live switches.** Kept as close-and-resume (see Premise).
- **The rotator itself and the markdown renderer.** Both move to `src/` unchanged; markdown
  keeps its own plan (`telegram-readable-output.md`), whose suite path is updated.
- **Prompting Fable to narrate.** The feed shows what happens; making the model say why is a
  prompt decision with a model-dependent outcome, not a gate this plan can hold.

## Ring

Ring 1 (unit): `bun test` runs every suite above without a network, a token or a binary.
`bun run typecheck` runs `tsc --noEmit` over the whole tree under a real `tsconfig.json`
with Bun types, so the check is no longer filtered by hand.

Ring 2 is the handoff: `bun run smoke` opens one real session through the new backend
with the production settings sources (text turn, a risky tool through the PreToolUse gate
into `canUseTool` with a deny honoured, the primed outbox contract, session id capture,
resume by id) and prints a verdict per check; it found three defects in this plan's first
implementation (see Premise). Then restart the bot and walk the wizard, an approval, a
question, the feed and `/status` from the phone. Green here is a handoff, not done.
