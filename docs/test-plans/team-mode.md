---
feature: a forum group shares one bot, every member chats in open topics, each topic runs a locked session profile (one MCP server set, no built-in tools, no prompts), and only admins can close, delete, wipe or reconfigure
suite:
  - src/config.test.ts
  - src/access.test.ts
  - src/profile.test.ts
  - src/team.test.ts
  - src/topics.test.ts
  - src/ui/keyboards.test.ts
gate: bun test
---

# Team mode: a group of people, one locked profile

## Premise

The request: open a telepath install to a Telegram group, so that any member can start a
topic and chat, while the sessions behind the topics can reach one set of MCP tools and
nothing else. What was checked, against the code at `ca72e9f`:

- **True: the install is single-user by one function.** `TelegramBot.allowed()`
  (`src/bot.ts`) admits an update only when `ctx.from.id` equals `ALLOWED_USER_ID` and
  the chat is `FORUM_CHAT_ID`; every handler in `wire()` calls it, and nothing else keys
  on the user id (`daemon.ts` only logs it). Widening it is one decision in one place.
- **True: every session is a full Claude Code session.** `SdkBackend.open()`
  (`src/session.ts`) sets `permissionMode: 'default'` and the daemon passes
  `settingSources: ['user', 'project', 'local']`; no `tools`, `mcpServers` or
  `allowedTools` are set, so a session has every built-in tool plus whatever the
  machine's settings and MCP config add. In a group that is a member running `Bash` on
  the host after one tap on Allow, by any other member.
- **True: the approval gate would deny the very tools a profile allows.** The
  `PreToolUse` hook (`src/gate.ts`) answers `permissionDecision: 'ask'` for every tool
  outside `AUTO_ALLOW`, which includes every `mcp__*` tool. Under `permissionMode:
  'dontAsk'` an `ask` is a denial, so a profile session must not install that hook; its
  job (forcing prompts past settings allow rules) does not exist when no settings are
  read and nothing may prompt.
- **False, and corrected: "`dontAsk` plus `allowedTools` is an exclusive allowlist".**
  `dontAsk` denies only a tool that would have prompted, and Claude Code auto-approves its
  read-only built-ins (`Read`, `Glob`, `Grep`, …), so a profile that kept `Read` in
  `tools` without listing it in `allowedTools` would still run it (found by the Codex
  pre-commit review, 12 Nov 2026). The profile therefore installs a hook of its own in
  place of the approval gate: `{}` for a listed tool, `deny` for every other name, so the
  allowlist holds whatever the CLI auto-approves now or later; and a kept built-in that is
  not allowed is refused at parse time, since the model would see a tool it can never use.
- **True: the SDK carries every option the profile needs.** `sdk.d.ts` of the bundled
  `@anthropic-ai/claude-agent-sdk@0.3.278` declares `tools`, `mcpServers`,
  `strictMcpConfig`, `allowedTools`, `permissionMode` with `'dontAsk'`,
  `settingSources`, `systemPrompt` (a string is a custom prompt that replaces Claude
  Code's), `cwd`, `model`, `effort`, `maxTurns` and `maxBudgetUsd`.
- **True: the typed and tapped paths let a user choose the working directory and switch
  approvals off.** `parseNew()` honours `cwd=` and `auto`; the wizard
  (`src/ui/wizard.ts`) ends in a folder, model, effort and approvals choice. In a group
  these are a member's choices about the host, so team mode must not route through
  either: a topic binds to the profile, full stop.
- **False, and corrected: "telepath needs a `claude login`".** Nothing checks for a
  login (`src/preflight.ts` reads only the binary's version). The child's environment is
  the daemon's (`CHILD_ENV` in `daemon.ts`, minus the bot token in
  `TopicManager.ensureLive`), so an `ANTHROPIC_API_KEY` in `.env` reaches the Claude
  Code child. That the child prefers it over a stored login is a Ring 2 check on a box
  with no login at all, not a unit test.
- **False, and corrected: "Telegram delivers a group's messages from its members only."**
  True of a private group; a public supergroup can let anyone post without joining
  (`join_to_send_messages` off), so a chat-id check alone would answer an outsider with
  the profile's tools (Codex pre-commit finding, 12 Nov 2026). Team mode therefore asks the
  forum itself whether the sender is a member (`getChatMember`), keeps the answer for a
  short while, and fails closed when the lookup fails. The bot, an admin with Manage
  Topics, receives every message regardless of privacy mode; that part stands.

Nothing in this change names a company, a product or a particular MCP server: the repo
is public, and the profile is the install's own file.

## Cases

Every row is one test. The case name is **verbatim** the string the test is registered
under, because `scripts/audit/test_plan_check.py` compares the two sets in both
directions and a paraphrase reads as a missing test.

| Case | Asserts | Mutant it kills |
|---|---|---|
| `team mode is off unless TEAM_MODE says so` | `teamMode` is false when `TEAM_MODE` is absent, `0` or `false`, and true for `1`, `true`, `on` | Default on: every existing single-user install opens its forum to anyone added to it |
| `admins are the allowed user plus ADMIN_USER_IDS` | `adminUserIds` holds `ALLOWED_USER_ID` and each id in `ADMIN_USER_IDS`, trimmed, deduplicated | `ADMIN_USER_IDS` replaces the allowed user, and the installing user loses admin on their own bot |
| `outside team mode only the allowed user in the forum is admitted` | with `teamMode` false, `admitted()` is true only for the allowed user id in the forum chat | The chat-only check of team mode applied to single-user installs |
| `in team mode every message in the forum chat is admitted` | with `teamMode` true, `admitted()` (the chat gate; membership is the row below) passes any user id in the forum chat | The user-id comparison kept, so members other than the owner are silently dropped (`rejected_updates`) |
| `in team mode a sender is admitted only when the forum reports them as a member` | `Membership.isMember()` is true for `creator`, `administrator`, `member`, and `restricted` with `is_member`; false for `left`, `kicked`, `restricted` without membership, and a status it has never seen | The chat id trusted on its own: a public forum that lets non-members post would hand the assistant and its tools to anyone (Codex finding); an unknown status read as membership |
| `a membership answer is cached, a failure only briefly, and a change the forum reports clears it` | a second check within the TTL calls the lookup once; after the TTL it calls again; a negative answer is re-checked after a short grace rather than the full TTL; a lookup that throws answers false, is kept for the grace only (bounded API load: a non-member or an API error costs one call per grace, not one per message), then asked again; `forget(id)` drops the entry so the next check asks the forum (wired to `chat_member` updates, so a kicked member loses access at once rather than at the TTL; security review) | No cache: one API round trip per message, forever; a thrown lookup cached as a rejection for the TTL, so one API hiccup locks a member out for ten minutes; a thrown lookup not cached at all, so a non-member posting fifty messages costs fifty serial calls ahead of everyone's (Claude review finding); a negative cached for the full TTL, so a member added just now is ignored for ten minutes; `forget` ignored, so a kicked member keeps access for the TTL |
| `members may chat, open topics, wrap up and toggle the feed` | `allowedAction()` admits, for a non-admin in team mode: chat text, `/new`, `/help`, `/menu`, `feed on/off`, `wrap up`, and the taps `m:menu`, `m:new`, `m:newhere`, `m:help`, `m:ctl`, `m:cancel`, `m:noop`, `m:tf`, `m:twrap`, `m:tw:now`, `m:tw:turn`, `m:tres`. Not `/status` or `m:status`: the status screen lists recent errors, the admin ids and every topic's title (security review, 12 Nov 2026). Not `m:treopen`: reopening undoes an admin's close (review, 13 Nov) | A member allowlist missing wrap-up or the feed, so members cannot stop a runaway turn in a shared topic; the status screen left in, so every member reads the box's errors and the admin list; reopen left in, so a member undoes an admin's close with one tap |
| `with a profile, the model, effort and approval actions are locked whoever taps them` | `profileLocked()` names exactly `m:tm:*`, `m:te:*`, `m:ta`, `/auto`, `use` and `effort`; the bot consults it at the same two gates as `allowedAction()`, so a locked action answers "Set in the profile" for admins too | A check per call site, so the next entry point that changes the binding escapes (review finding); `/auto` or the typed `use` missing from the list |
| `a prompt tap is honoured only from its own topic, and an approval only by an admin in team mode` | `promptTapAllowed()`: outside team mode every tap passes as before; in team mode a clarifying-question option counts only when tapped in the topic that asked, and an Allow/Deny only when tapped there by an admin | A `qa:` or `p:` token honoured from any topic (a member answers or approves another topic's prompt by replaying its token, Claude review finding); an approval by a member |
| `a topic that has spent the profile's budget stays closed across idle stretches` | with `budgetUsd` set, the spend each stretch's results report, successful or failed, accumulates in the binding (`spentUsd`) across evictions and resumes; every stretch opens with the remaining budget (the cap minus what is spent), never the full cap; a message into a topic at or over the budget is answered with a notice and opens no session; a stretch ending in `error_max_budget_usd` counts as the budget spent; without a budget nothing is tracked or written | Spend not carried across stretches: the SDK's `maxBudgetUsd` is per `query()`, so every idle timeout hands the topic a fresh budget (Claude review finding); a resumed stretch opened with the full cap, so a topic at $9.99 of $10 spends another $10 before the check bites (Codex finding); a failed turn's spend dropped, so repeated failing stretches exceed the cap (Codex finding); the refusal only while a session is live; spend tracked and the registry rewritten on every turn of an install with no budget (review finding) |
| `outside team mode no action is admin-gated` | with `teamMode` false, `allowedAction()` admits every action for the admitted user, whatever the admin list holds (the two lists are independent concerns) | Gating applied to single-user installs: the one user is refused by their own bot. The admin-list clause is what makes this row kill it: the config always lists the allowed user as an admin, so a test with that config would pass through `isAdmin` and never notice |
| `a profile session runs with no built-in tools and only the profile's MCP servers` | `profileOptions()` yields `tools` equal to the profile's list (`[]` when empty), `mcpServers` equal to the profile's, and `strictMcpConfig: true` | `tools` left undefined, so every built-in tool is available; `strictMcpConfig` off, so the machine's own MCP servers merge in |
| `a profile session auto-allows exactly the profile's tools and never prompts` | `allowedTools` equals the profile's `allowedTools` and `permissionMode` is `'dontAsk'` | `permissionMode: 'default'`: a prompt appears in an open group, and anyone can tap Allow |
| `a profile session reads no settings files and its only hook denies every tool outside the allowlist` | `settingSources` is `[]`; `hooks.PreToolUse` holds one matcher whose callback answers `{}` for a listed tool and a `deny` decision for `Read`, `Bash` and an MCP tool of an undeclared server | The daemon's setting sources inherited; the approval gate kept (its `ask` denies the allowed tools under `dontAsk`); no hook at all, so a kept read-only built-in, which never prompts, runs though unlisted |
| `a profile session uses the profile's prompt, cwd, model, effort and caps, not the binding's` | `systemPrompt` is the profile's text as a plain string, `cwd`, `model`, `effort`, `maxTurns` and `maxBudgetUsd` come from the profile; the binding's `cwd` and `model` are ignored, and `resume` and `env` pass through; when the topic manager passes the stretch's remaining budget, that is the stretch's `maxBudgetUsd` | The binding's cwd used (a member's topic runs in whatever folder the binding carries); the prompt appended to Claude Code's preset instead of replacing it; the remaining budget ignored in favour of the profile's full cap |
| `a profile's prompt file and cwd resolve against the profile's directory, absolute paths as given` | `systemPromptFile` and `cwd` are resolved against the profile file's directory; an absolute path is used as it is | Resolved against the process working directory, so the service unit's cwd decides whether the bot has a prompt; `join` instead of `resolve`, so an absolute prompt path is mangled into a sub-path and a relative cwd is checked against the daemon's directory but handed to the child unresolved (Claude review finding) |
| `/new in team mode takes the rest of the line as the title and ignores cwd= and auto` | `parseTeamNew()` returns the joined words as the title, never a cwd or an auto flag, and an empty title falls back to the member's name and the time | `parseNew()` reused: a member sets the working directory or switches approvals off from a chat message |
| `a profile session's first message carries no outbox contract` | with `primeContract: false`, the first `send` into a session is the user's text alone | The contract always prepended, telling a session with no file tools to save files into a directory |
| `the team main menu offers only a new topic and help` | `mainMenuKb({ team: true })` has exactly those two buttons (status is the admins', typed), and the default menu is unchanged | The full menu in team mode: settings, the session list and the status screen reachable by every member |
| `the team topic panel has no model, effort or auto buttons` | `topicControlsKb(catalog, b, { team: true })` and `topicControlsKb(catalog, b, { profile: true })` carry the feed toggle and the close, delete and wipe actions only; the panel text names neither model nor approvals; the default panel is unchanged | The full panel in team mode: a tap switches the shared profile's model. The full panel in a single-user profile install: buttons that change what the panel shows and nothing the session does (Codex finding, 12 Nov 2026) |

### Negative cases

The rows above say what must happen. These say what must **not**: the refusals and the
caps a wrong implementation would happily allow.

| Case | Must not happen | Mutant it kills |
|---|---|---|
| `team mode refuses to start without PROFILE_FILE` | `parseConfig()` with `TEAM_MODE=1` and no `PROFILE_FILE` throws `ConfigError` naming `PROFILE_FILE` | The requirement dropped: a group gets full Claude Code sessions on the host |
| `in team mode a message from any other chat is rejected` | a DM to the bot or a message in another group is not admitted, whoever sent it, admins included | The chat check dropped with the user check, so anyone who finds the bot gets a session |
| `everything else is admins only in team mode, unknown actions included` | for a non-admin, `allowedAction()` refuses `m:tclose`, `m:treopen`, `m:tdelete`, `m:tdelyes`, `m:twipe`, `m:twipeyes`, `m:tm:*`, `m:te:*`, `m:ta`, `m:settings`, `m:sdm:*`, `m:list`, `m:sess:*`, `m:resume`, `m:quick`, `m:status`, `/status`, `/attach`, `/auto`, `use`, `effort`, and an action name that does not exist yet | A denylist instead of an allowlist: the next button ships open to every member |
| `a topic an admin closed opens no session until an admin reopens it` | with `closed` set on the binding (💾 Close & keep), `sendToTopic()` answers with a notice and opens nothing, `ensureLive()` returns undefined, and clearing `closed` (♻️ Reopen, admins only) restores both | The close only ends the live session, so any member's message or ▶️ Resume reopens it (review finding); the notice given but a session opened anyway |
| `a profile names its MCP servers, a non-empty prompt and an existing cwd, or is refused` | `parseProfile()` reports every problem at once: no `mcpServers`, an empty prompt, a `cwd` that is not a directory | An empty prompt accepted (a bare Claude Code answering a group); a missing cwd accepted (the session runs in the daemon's directory) |
| `an allowed tool must name a declared MCP server or a kept built-in tool` | `allowedTools` entries are `mcp__<server>__<tool>` with `<server>` in `mcpServers`, or a name in `tools`; anything else is refused. The converse holds too: every name in `tools` is in `allowedTools`, or the profile is refused. `AskUserQuestion` is refused in `tools` outright: a profile session never prompts (`dontAsk` denies it, and an allowlisted tool is auto-approved before the question could be rendered), so the model would get an empty answer (review, 13 Nov) | Any name accepted: a typo in the allowlist means a bot that denies every call and nobody knows why. A kept-but-unlisted built-in accepted: the model is shown a tool the hook denies on every call. `AskUserQuestion` accepted: question-less turns that look like a silent model |
| `team mode refuses a profile without a budget` | `teamProfileProblems()` names `maxBudgetUsd` when the profile has none, and nothing otherwise; the daemon refuses to boot on it in team mode, as it does without a profile | No check: a shared forum runs with unbounded spend per topic while the docs promise a cap (review finding) |

## Out of scope

- **A per-member daily topic cap.** The first group is two people; the live-session cap,
  idle eviction and the per-session budget bound the spend. Added when the group widens,
  as a row in this plan.
- **Per-member identities or tiers.** One profile is one principal; every topic sees the
  same. A profile per member is a different feature.
- **Direct messages to the bot.** Rejected by design: the forum group is the access list.
- **Voice notes, media, the rotator relay and the status message**: unchanged, and
  covered by their own plans.
- **A topic's title from Telegram's topic-created service message.** Cosmetic; `/new
  <title>` and the member-plus-time fallback name topics for now.
- **The bot's own wiring in `src/bot.ts`** (which handler calls which pure function)
  stays untested here, as the rest of that file is; the decisions it calls are the rows
  above, and the manual run below exercises the wiring. After the first review (12 Nov
  2026) that wiring also holds: in team mode plain text in General gets no menu (members
  talk there too); with a profile, a photo, file or video is answered with a notice and
  not forwarded (the session has no file tool, and the host path stays out of the chat);
  typed `use`, `effort` and `/auto` and the matching taps answer that the profile owns
  them; a pending free-text answer is delivered before the admin gate runs; the forum's
  `chat_member` updates clear the membership cache. After the second round (13 Nov): a
  forwarded voice note in a fresh team topic binds the topic like typed text does and a
  failed send is said; the membership lookup is capped at five seconds, so one slow API
  answer cannot hold every topic's updates; ♻️ Reopen reports when no session could open;
  the boot warns when the bot is not an admin of the forum, since `chat_member` updates
  reach admins only.
- **Every fresh topic in team mode is a conversation with the assistant.** That is the
  requested behaviour (members open a topic and ask). The trade-off, raised in review: a
  topic opened for a human-only thread is bound on its first message and every line is
  answered and billed. A forum that needs human-only threads keeps them in another group.

## Ring

Ring 1 (`bun test`, `bun run typecheck`) on its own. Ring 2 is a run on a host with a
second Telegram account in a test forum: the second account chats in a fresh topic and is
answered; its taps on delete, wipe and model are refused; the activity feed shows only
`mcp__*` calls; a topic whose budget is spent ends with `error_max_budget_usd`; a DM to
the bot gets nothing; and, on a host with no `claude login`, the sessions run on the
`ANTHROPIC_API_KEY` from `.env`.
