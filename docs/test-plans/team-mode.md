---
feature: a forum group shares one bot, every member chats in open topics, each topic runs a locked session profile (one MCP server set, no built-in tools, no prompts), and only admins can close, delete, wipe or reconfigure
suite:
  - src/config.test.ts
  - src/access.test.ts
  - src/profile.test.ts
  - src/team.test.ts
  - src/commands.test.ts
  - src/topics.test.ts
  - src/throttle.test.ts
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

- **False, and corrected twice: "a resumed Claude Code process reports its own cost, not
  the topic's."** The second review asked whether `total_cost_usd` restarts per `query()`
  or carries a resumed session's history. A CLI probe (one Haiku turn 0.0041, then three
  resumed one-word turns at 0.0075, 0.0079, 0.0082) was first read as "flat, so per
  process". The fifth review pointed at the SDK's own text (`sdk.d.ts`, `total_cost_usd`):
  "a resumed or forked session continues from the total its transcript saved (so the
  first result already carries the earlier turns; `maxBudgetUsd` counts only the spend
  since this query() call started)". The probe agrees once read right: each resumed turn
  added three to four tenths of a cent on top of the carried total, as a cached one-word
  turn does. So a result's total **is** the topic's running total, the latest result is the
  spend (never a sum across stretches), and the remaining budget handed to a stretch stays
  right, since the SDK's own cap counts only that stretch.
  **One bound, stated rather than closed (seventh round, Codex; narrowed in the ninth):**
  a stretch whose transcript saved no total restarts its counter, and when such a
  stretch's first turn costs at least the last total the transcript reported it reads as a
  carried total, so the record falls short by that last total: at most one cap, once per
  lost transcript, and only for a transcript this bot did not see complete a turn. (The
  seventh round read the restart against the record instead, which charged every stretch
  after a lost one its history a second time.) The SDK's usage query would make this exact
  and is marked experimental ("do not rely on it yet"), so it is not used.
  **A stretch paused before its first result reports no spend** (second security read).
  With stuck meaning silent, the only running turn a shared forum ever pauses is one that
  produced nothing for ten minutes. The third security read noted that a long single
  answer is silent too when the pump sees an assistant message only once it is complete,
  and bills on disconnect; so profile sessions stream their deltas
  (`includePartialMessages`), every delta counts as output, and silent now means no
  tokens flowing: a hung process, or a tool the server is slow on, neither of which
  spends. The unrecorded part is at most what such a turn spent before it went silent,
  once per hang. It is not charged as the stretch's cap: that would close a topic for a
  tool's hang. The fifteenth round's claim that the remainder handed to a resumed stretch
  trips against the transcript's cumulative total is refuted by the same typings:
  `maxBudgetUsd` counts the current `query()` only.
- **No prompt can occur under a profile today**: `tools` cannot hold `AskUserQuestion`,
  `dontAsk` never prompts, and no `canUseTool` is passed. The tap policy for Allow/Deny and
  question buttons (second round) was removed in the fifth round as unreachable and put
  back in the sixth on the security review's objection: it is defense in depth for a path
  a later change could reopen without noticing, and a pure rule with its mutants costs
  little to keep. The single-user tap handling is as it was.
- **Telegram answers 400 for an id the chat has never seen**, not `status: left`, and
  posts by an anonymous admin or a linked channel carry a proxy `from` (with
  `sender_chat` set) that no member list contains (sixth round). So a 400 is a no, not a
  blip, and a post with `sender_chat` is refused outright with its own notice.

Nothing in this change names a company, a product or a particular MCP server: the repo
is public, and the profile is the install's own file.

## Cases

Every row is one test. The case name is **verbatim** the string the test is registered
under, because `scripts/audit/test_plan_check.py` compares the two sets in both
directions and a paraphrase reads as a missing test.

| Case | Asserts | Mutant it kills |
|---|---|---|
| `team mode is off unless TEAM_MODE says so` | `teamMode` is false when `TEAM_MODE` is absent, `0` or `false`, and true for `1`, `true`, `on` | Default on: every existing single-user install opens its forum to anyone added to it |
| `admins are the allowed user plus ADMIN_USER_IDS` | `adminUserIds` holds `ALLOWED_USER_ID` and each id in `ADMIN_USER_IDS`, trimmed, deduplicated, each a numeric Telegram id, or a config problem that names the offending entry | `ADMIN_USER_IDS` replaces the allowed user, and the installing user loses admin on their own bot; entries unchecked, so a space instead of a comma yields one admin id that matches nobody and the second admin is a plain member with no word at boot (review, 13 Nov) |
| `outside team mode only the allowed user in the forum is admitted` | with `teamMode` false, `admitted()` is true only for the allowed user id in the forum chat | The chat-only check of team mode applied to single-user installs |
| `in team mode every message in the forum chat is admitted` | with `teamMode` true, `admitted()` (the chat gate; membership is the row below) passes any user id in the forum chat | The user-id comparison kept, so members other than the owner are silently dropped (`rejected_updates`) |
| `in team mode a sender is admitted only when the forum reports them as a member` | `Membership.check()` is `member` for `creator`, `administrator`, `member`, and `restricted` with `is_member` and not muted (`can_send_messages` not false); `no` for `left`, `kicked`, `restricted` without membership or muted, and a status it has never seen | The chat id trusted on its own: a public forum that lets non-members post would hand the assistant and its tools to anyone (Codex finding); an unknown status read as membership; a muted member admitted, so Telegram drops their messages but their taps still open topics and spend budget (ninth review) |
| `a membership answer is cached, a failure only briefly, and a change the forum reports clears it` | a second check within the TTL calls the lookup once; after the TTL it calls again; a negative answer is re-checked after a short grace rather than the full TTL; a lookup that throws answers `unknown` (`isMember` false), is kept for the grace only (bounded API load: a non-member or an API error costs one call per grace, not one per message), then asked again; `check()` tells `unknown` from `no`, so the bot can say "could not verify you, try again in a moment" instead of dropping the message in silence (review, 13 Nov); `forget(id)` drops the entry so the next check asks the forum (wired to `chat_member` updates, so a kicked member loses access at once rather than at the TTL; security review). An admin from the config is admitted without asking the forum (`membershipRequired()`), so an API blip never locks the admins out. Concurrent checks of one id share one lookup; expired entries are swept once the cache passes its size, and when nothing has expired the entry expiring soonest goes (a stranger's grace before a member's TTL, whoever arrived first), so neither a flood of strangers nor a forum larger than the cache grows memory without bound (review, 13 Nov; eleventh review); a lookup that throws before returning a promise is a failed lookup like any other (unknown, kept for the grace). A lookup Telegram answers with 400 "user not found" (or `PARTICIPANT_ID_INVALID`, `USER_ID_INVALID`) is a no, not an unknown; any other failure, a 400 about the chat included (chat not found, member list inaccessible: a misconfiguration, not a stranger), is unknown; `noticeDue(id)` is true once per fresh unknown, so the bot's "could not verify" notice rides the same grace as the verdict, with no second timer; a lookup writes its answer only while it is still the pending one for its id (a per-lookup token; `forget` clears the pending one), so neither a lookup orphaned by a removal nor one overtaken by a second removal can cache a stale yes (ninth review and the security review: a per-id counter deleted by the orphan let the second removal go unseen) | No cache: one API round trip per message, forever; a thrown lookup cached as a rejection for the TTL, so one API hiccup locks a member out for ten minutes; a thrown lookup not cached at all, so a non-member posting fifty messages costs fifty serial calls ahead of everyone's (Claude review finding); a negative cached for the full TTL, so a member added just now is ignored for ten minutes; `forget` ignored, so a kicked member keeps access for the TTL; `unknown` reported as `no`, so a blip reads as a kicked member; admins put through the lookup, so a blip locks out the only people who could fix it; no in-flight dedupe, so a burst from one unknown sender is one call per message; no sweep, so every stranger's id stays until restart; a 400 read as a blip, so every outsider in a public forum gets a "could not verify" notice and the counters read as an outage; every 400 read as a no, so a stale `FORUM_CHAT_ID` or a bot removed from the forum refuses every member in silence while the exempt admins see it working (review, 13 Nov); a notice on every message of the grace, or never; a pending lookup's stale yes written over a `forget`, so a removed member chats on for ten minutes; a cap that only ever drops expired entries, so a forum larger than the cache grows it without bound (eighth review); the per-id counter the orphan deleted, so a second removal during the replacement lookup went unseen; a token that asks "is any lookup pending for this id" rather than "is it this one", so an orphan's late yes overwrites its replacement's no and drops it from the map (ninth review); the first-inserted key evicted, so a long-standing member pays a lookup on the update loop each time a stranger arrives (eleventh review) |
| `members may chat, open topics, wrap up and toggle the feed` | `allowedAction()` admits, for a non-admin in team mode: chat text, `/new`, `/help`, `/menu`, `feed on/off`, `wrap up`, and the taps `m:menu`, `m:new`, `m:newhere`, `m:help`, `m:ctl`, `m:cancel`, `m:noop`, `m:tf`, `m:twrap`, `m:tw:now`, `m:tw:turn`, `m:tres`. Not `/status` or `m:status`: the status screen lists recent errors, the admin ids and every topic's title (security review, 12 Nov 2026). Not `m:treopen`: reopening undoes an admin's close (review, 13 Nov) | A member allowlist missing wrap-up or the feed, so members cannot stop a runaway turn in a shared topic; the status screen left in, so every member reads the box's errors and the admin list; reopen left in, so a member undoes an admin's close with one tap |
| `with a profile, the model, effort and approval actions are locked whoever taps them` | `profileLocked()` names exactly `m:tm:*`, `m:te:*`, `m:ta` and `/auto`; the bot consults it at the tap gate and the slash gate, beside `allowedAction()`, so a locked action answers "Set in the profile" for admins too. Its sibling `profileFreshOnly()` names the actions that would bind an old transcript, or list the host's transcripts to pick one from (`/attach`, `m:resume`, `m:sess:*`, `/list`, `m:list`), consulted at the same two gates and answered "every topic starts fresh", so a new resume-like entry point is covered by the set rather than by an if-branch its author must remember (eighth review). Typed `use …` and `effort …` are not on it: under a profile they configure nothing, so the bot rewrites them to chat before any gate (a member answering "effort high" to a question is answering the question; review, 13 Nov), and no typed kind is consulted against the lock | A check per call site, so the next entry point that changes the binding escapes (review finding); `/auto` missing from the list; `use` or `effort` on it, so a member's reply is refused as "Admins only"; `/attach` missing from the fresh-only set, so an old transcript is bound under a profile after all; `/list` missing from it, so an admin reaches a dead list whose every pick is refused, painted from the host's transcript titles into a forum any member reads (twelfth review) |
| `a slash command keeps its name when Telegram appends the bot's handle` | given this bot's username, `parseTyped('/new@telepath_bot pricing')` is the slash command `new` with args `pricing`, case-insensitively; a command addressed to another bot (`/new@other_bot`), or any suffixed command when the username is unknown, is `foreign` and the bot ignores it | The suffix kept, so a command tapped from the group's command menu reads `new@telepath_bot`: members are refused as "Admins only" and admins fall to the main menu (review finding); any handle accepted, so another bot's `/new@other_bot` opens a topic here (Codex finding) |
| `a member may open only so many topics a day` | `TopicQuota.take(uid)` admits a member's first N topic openings of a calendar day and refuses the next; the count is per member and starts over on the next day, on the box's local clock, the same clock the default title shows (ninth review: a UTC day told a member "come back tomorrow" past local midnight); an opening is reserved with `take` before Telegram is asked and given back with `refund(uid)` when Telegram refuses, so a failed creation is not charged and two openings in flight cannot both pass the cap (a check-then-act `peek` would, Codex finding); `refund` never goes below zero; a reservation taken before midnight and refunded after is refunded against nothing and shortens nothing, since the counter starts over with the day (fifteenth review's claim, refuted); the configured admins and single-user installs are exempt by the one rule the membership gate uses (`membershipRequired()`), not a second copy of it | No cap: a member who taps 🆕 ten times gets ten budgets (review finding); one count shared by every member, so one member locks the others out; a count that never resets; a refund that does nothing, so twenty failed creations lock a member out for the day; admins charged, though the docs call it a member limit (review, 13 Nov) |
| `the per-member topic cap defaults to twenty a day and must be positive` | `TEAM_TOPICS_PER_DAY` is read into `teamTopicsPerDay`, twenty when unset, and a zero or negative value is a config problem | Default zero, so nobody can open a topic; a non-positive value accepted, so the cap is either off or nonsense |
| `the stuck-turn bound defaults to ten minutes and must be positive` | `STUCK_TURN_MINUTES` is read into `stuckTurnMinutes`, ten when unset, and a zero or negative value is a config problem; the daemon hands it to the manager as `stuckTurnMs` (fourteenth review: a profile with a slow tool must be able to raise it, since silence cannot tell a hung process from a tool still working) | A fixed ten minutes, so a twelve-minute tool is cut mid-turn on every install; a non-positive value accepted, so every running turn is stuck at once |
| `a topic that has spent the profile's budget stays closed across idle stretches` | with `budgetUsd` set, the binding's `spentUsd` follows every result, successful or failed, by its increment over the last total the transcript reported (`reportedUsd`): a total at or above that last total continues it (within a stretch, and across a resume whose transcript saved its total, per the SDK), a total below it means the transcript restarted and counts whole (a crash or a kill mid-turn saved none), so a stretch after a lost one is not charged twice (ninth review: comparing against the record instead charged every later stretch's history again); a binding recorded before the reported total was kept (`spentUsd`, no `reportedUsd`) takes its record as the baseline for its first result (Codex hook, ninth round); a rate-limit or rotation continuation into a topic whose budget was spent meanwhile is not announced as resuming: the nudge decides, and the topic is told its budget is used (tenth review); a refused message is counted every time and answered at most once a minute per topic, so a member's flood of refused messages is not the bot's flood and, under Telegram's 429 retries on the bot's replies, not a stall of every topic (second security read); a result reporting a total of zero (a crash or startup-error result, which the SDK says may carry zeroed values) is no information and moves nothing; never a sum of stretch totals, never a max that misses a restarted stretch; kept across evictions and resumes; every stretch opens with the remaining budget (the cap minus what is spent), never the full cap; a message into a topic at or over the budget is answered with a notice and opens no session, and a nudge (the rate-limit or rotation continuation, sent `quiet`) into such a topic posts nothing and reports undelivered; a stretch ending in `error_max_budget_usd` counts as the budget spent; without a budget nothing is tracked or written | Spend not carried across stretches: the SDK's `maxBudgetUsd` is per `query()`, so every idle timeout hands the topic a fresh budget (Claude review finding); stretch totals summed, so every resume double-counts the earlier stretches and a topic is refused at half its cap (the formula the plan first had; fifth review); a max of totals, so a stretch whose transcript saved no total restarts at zero and its whole spend goes unrecorded (seventh review); the restart read against the record rather than the transcript's last total, so every stretch after a lost one is charged its history twice and the topic is refused at three quarters of its spend (ninth review); the record ignored as the baseline of a binding from before `reportedUsd` existed, so its first carried result adds its history again (Codex hook, ninth round); the record preferred over the transcript's total once both exist, the ninth-review defect by another route; the continuation announced before its nudge, so an exhausted topic reads "resuming" and then nothing (tenth review); an undelivered nudge left unexplained, the same hang by another route; a notice per refused message, so one member's flood of lines into a spent topic is the bot's flood (second security read); a zeroed result taken as the stretch's last total, so the next real total is added in full and the topic is refused at double its spend (eighth review); a nudge that says "closed" or "budget" to a topic nobody wrote in (eighth review); a resumed stretch opened with the full cap, so a topic at $9.99 of $10 spends another $10 before the check bites (Codex finding); a failed turn's spend dropped, so repeated failing stretches exceed the cap (Codex finding); the refusal only while a session is live; spend tracked and the registry rewritten on every turn of an install with no budget (review finding) |
| `in a shared forum a running turn is paused for another topic only once it is stuck; until then the newcomer waits` | with `shared` set, at the live-session cap `ensureLive()` pauses the longest-idle session for a new topic and never one mid-turn; when every slot is held by a running turn, `openRefusal()` is `busy`, so `sendToTopic()` tells the newcomer to send again in a moment and opens nothing, a `quiet` nudge reports undelivered, and nobody's turn is killed; a turn silent (no output, no message) for `stuckTurnMs` (default ten minutes) is stuck and pausable after all, longest-silent first, so hung tools cannot hold every slot for good, while output counts as activity, so a long turn still producing is never paused (thirteenth review and the second security read: measured from the send, an eleven-minute working turn was killed for a newcomer), and silence is measured from the session's last stream message alone, so a member typing "hello?" into a hung topic does not keep its slot (fourteenth review), while a new turn's silence counts from its send, so a session idle past the bound is not stuck before its first output (Codex hook), and a turn parked on a rate limit with a resume scheduled is waiting, not hung, so it is not evicted and then told "resuming" by the resume (nineteenth review); the bound is `STUCK_TURN_MINUTES`, to be set above the longest tool call the profile allows, since silence cannot tell a hung process from a slow tool; `evictIdle()` ends a stuck turn in a shared forum too, so a hung process does not wait for cap pressure; without `shared` the longest-idle session is paused for the new topic, running or not, as on main (twelfth review: the refusal was every mode's, and a turn that never ended pinned its slot forever) | The victim chosen by `lastActive` alone, so a member opening `MAX_LIVE_SESSIONS` fresh topics kills a colleague's running turn, repeatedly (security review); the busy rule missing, so the cap is exceeded when nothing can be paused; no stuck bound, so three hung turns close the forum until an admin finds them; the shared rule applied to a single user, whose own message is dropped instead of pausing their own session (twelfth review); stuck measured from the send, so a turn still producing is paused (thirteenth review); silence measured from any activity, so members' messages keep a hung turn's slot (fourteenth review); the output clock left at the last turn's end, so a session idle past the bound is killed at the start of its next turn (Codex hook); a parked turn evicted as stuck, so its scheduled resume later announces work the eviction called lost (nineteenth review); a stuck turn kept by idle eviction, so a hung process lives until the cap is hit |
| `a refusal is said at most once a minute per key` | `Throttle.allow(key)` is true `limit` times (default one) per key per window and false after, until the window turns; keys are independent; once the map is large, entries past their window are swept, so a flood of keys cannot grow it without bound. The bot's one rule for replies a member can trigger at will ("Admins only", the quota, the text-only, voice and wrap-up notices, the help text, the menus, feed flips, error notices, and the manager's refusals of a spent, closed or full topic, which reach it through `replyAllowed` in the manager's deps, required so the rule has one implementation) is one throttle keyed by topic and kind and one keyed by sender at ten a minute, since the key space of topics is a member's to grow (third security read); outside team mode the rule answers everything, since the throttles are a shared forum's and one user's notices must all be answered (seventeenth review) | The window ignored, so every refused message is answered; the key ignored, so one member's flood mutes every topic's notices; the limit ignored, so a sender's allowance is one or unbounded; no sweep, so a flood of topic ids grows the map for the process's life |
| `under a profile, a binding made before the profile opens a fresh session, not its old transcript` | with `profileSessions` set, `ensureLive()` resumes a binding's session only when the binding was made under the profile (`profile: true`); any other binding opens with no `resume`, its old session id is dropped from the registry, and the binding becomes the profile's from then on, so the fresh session it opens is resumed by later stretches like any profile topic's; with a budget, the dropped transcript's baseline goes with it (`reportedUsd` reset to zero), so the fresh session's first result counts whole (tenth review); a stream error under a profile is said without its detail, which the log keeps, since a spawn or transcript error names host paths, and with it where the forum is one person's, as before (twelfth review); the old session's hand-off and approval mode go with its id, since ▶️ Resume would otherwise feed the operator's repo path, branch and next command to the profile session (third security read) | Resume regardless of who made the binding, so switching an install to team mode republishes every earlier session through its topic (review, 13 Nov); the session id kept, so the next stretch resumes it after all; the binding never marked, so every restart drops the fresh session again and the topic loses its thread each time (Codex finding); the dead baseline kept, so the fresh session's first result is charged short by the old transcript's total (tenth review); the raw stream error posted under a profile, naming the host's paths to the forum (twelfth review); the hand-off kept, so a member's ▶️ Resume replays the operator's last single-user instruction into the forum (third security read) |
| `outside team mode no action is admin-gated` | with `teamMode` false, `allowedAction()` admits every action for the admitted user, whatever the admin list holds (the two lists are independent concerns) | Gating applied to single-user installs: the one user is refused by their own bot. The admin-list clause is what makes this row kill it: the config always lists the allowed user as an admin, so a test with that config would pass through `isAdmin` and never notice |
| `a profile session runs with no built-in tools and only the profile's MCP servers` | `profileOptions()` yields `tools` equal to the profile's list (`[]` when empty), `mcpServers` equal to the profile's, `strictMcpConfig: true`, and `includePartialMessages: true`, so the pump sees every delta and a shared forum's "stuck" means no tokens flowing (third security read: an assistant message arrives only once complete, so a long answer looked silent and bills on disconnect) | `tools` left undefined, so every built-in tool is available; `strictMcpConfig` off, so the machine's own MCP servers merge in; deltas not streamed, so a ten-minute answer is killed as stuck and its spend never recorded |
| `a profile session auto-allows exactly the profile's tools and never prompts` | `allowedTools` equals the profile's `allowedTools` and `permissionMode` is `'dontAsk'` | `permissionMode: 'default'`: a prompt appears in an open group, and anyone can tap Allow |
| `a profile session reads no settings files and its only hook denies every tool outside the allowlist` | `settingSources` is `[]`; `hooks.PreToolUse` holds one matcher whose callback answers `{}` for a listed tool and a `deny` decision for `Read`, `Bash` and an MCP tool of an undeclared server | The daemon's setting sources inherited; the approval gate kept (its `ask` denies the allowed tools under `dontAsk`); no hook at all, so a kept read-only built-in, which never prompts, runs though unlisted |
| `a profile session uses the profile's prompt, cwd, model, effort and caps, not the binding's` | `systemPrompt` is the profile's text as a plain string, `cwd`, `model`, `effort`, `maxTurns` and `maxBudgetUsd` come from the profile; the binding's `cwd` and `model` are ignored, and `resume` and `env` pass through; when the topic manager passes the stretch's remaining budget, that is the stretch's `maxBudgetUsd` | The binding's cwd used (a member's topic runs in whatever folder the binding carries); the prompt appended to Claude Code's preset instead of replacing it; the remaining budget ignored in favour of the profile's full cap |
| `a profile's prompt file and cwd resolve against the profile's directory, absolute paths as given` | `systemPromptFile` and `cwd` are resolved against the profile file's directory; an absolute path is used as it is | Resolved against the process working directory, so the service unit's cwd decides whether the bot has a prompt; `join` instead of `resolve`, so an absolute prompt path is mangled into a sub-path and a relative cwd is checked against the daemon's directory but handed to the child unresolved (Claude review finding) |
| `/new in team mode takes the rest of the line as the title and ignores cwd= and auto` | `parseTeamNew()` returns the joined words as the title, never a cwd or an auto flag, an empty title falls back to the member's name and the time, and the title is capped at 120 characters (Telegram's topic-name limit) where it is parsed, so the binding, the panel and the confirmation carry the same title the topic got | `parseNew()` reused: a member sets the working directory or switches approvals off from a chat message; no cap, so a pasted log as a title leaves the topic with no pinned panel (the panel message exceeds 4096; review, 13 Nov) |
| `a profile session's first message carries no outbox contract` | with `primeContract: false`, the first `send` into a session is the user's text alone | The contract always prepended, telling a session with no file tools to save files into a directory |
| `the team main menu offers only a new topic and help` | `mainMenuKb({ team: true })` has exactly those two buttons (status is the admins', typed), and the default menu is unchanged | The full menu in team mode: settings, the session list and the status screen reachable by every member |
| `the team topic panel has no model, effort or auto buttons` | `topicControlsKb(catalog, b, { team: true })` and `topicControlsKb(catalog, b, { profile: true })` carry the feed toggle and the close, delete and wipe actions only; the panel text names neither model nor approvals; the default panel is unchanged; a closed binding's panel in team mode is the closed state (♻️ Reopen, delete, wipe; "Closed by an admin"), so the pinned panel is where the refusal says to reopen and a refresh keeps the button, while outside team mode the flag changes nothing on the panel (seventeenth review) | The full panel in team mode: a tap switches the shared profile's model. The full panel in a single-user profile install: buttons that change what the panel shows and nothing the session does (Codex finding, 12 Nov 2026). The open panel painted over a closed topic's, so the only Reopen button vanishes on the next ⚙️ (seventeenth review) |

### Negative cases

The rows above say what must happen. These say what must **not**: the refusals and the
caps a wrong implementation would happily allow.

| Case | Must not happen | Mutant it kills |
|---|---|---|
| `team mode refuses to start without PROFILE_FILE` | `parseConfig()` with `TEAM_MODE=1` and no `PROFILE_FILE` throws `ConfigError` naming `PROFILE_FILE` | The requirement dropped: a group gets full Claude Code sessions on the host |
| `in team mode a message from any other chat is rejected` | a DM to the bot or a message in another group is not admitted, whoever sent it, admins included; nor is a post with a `sender_chat` (an anonymous admin posting as the group, a linked channel), whose `from` is a proxy id no member list holds | The chat check dropped with the user check, so anyone who finds the bot gets a session; a proxy sender put through the member lookup, so an anonymous admin is refused every thirty seconds with a notice that names the wrong cause (review, 13 Nov) |
| `everything else is admins only in team mode, unknown actions included` | for a non-admin, `allowedAction()` refuses `m:tclose`, `m:treopen`, `m:tdelete`, `m:tdelyes`, `m:twipe`, `m:twipeyes`, `m:tm:*`, `m:te:*`, `m:ta`, `m:settings`, `m:sdm:*`, `m:list`, `m:sess:*`, `m:resume`, `m:quick`, `m:status`, `/status`, `/attach`, `/auto`, `use`, `effort`, and an action name that does not exist yet | A denylist instead of an allowlist: the next button ships open to every member |
| `a prompt tap is honoured only from its own topic, and an approval only by an admin in team mode` | `promptTapAllowed()`: outside team mode every tap passes as before; in team mode a clarifying-question option counts only when tapped in the topic that asked, and an Allow/Deny only when tapped there by an admin. Defense in depth: no profile session prompts today (premise) | A `qa:` or `p:` token honoured from any topic (a member answers or approves another topic's prompt by replaying its token, Claude review finding); an approval by a member |
| `a topic an admin closed opens no session until an admin reopens it` | with `closed` set on the binding (💾 Close & keep) and `shared` (team mode) on the manager, `sendToTopic()` answers with a notice and opens nothing, a `quiet` send (a nudge) posts nothing and reports undelivered, `ensureLive()` returns undefined, and clearing `closed` (♻️ Reopen, admins only) restores both; without `shared` the flag is ignored and cleared by the resume it does not block, so a single user's kept topic resumes on its next message as before and a flag left by an earlier team-mode run cannot lock a topic in use (eleventh review: the one reader decides, in place of a boot-time sweep; twelfth: the flag a resume leaves behind; seventeenth: the bot writes it in team mode only, where the pinned panel then shows the closed state with ♻️ Reopen and stays pinned, so a later refresh keeps the button and "reopen it from the pinned panel" is true) | The close only ends the live session, so any member's message or ▶️ Resume reopens it (review finding); the notice given but a session opened anyway; the flag honoured whatever the mode, so a kept topic answers "an admin closed this" to its only user (review, 13 Nov; ninth review); the flag ignored even when honoured; the flag left set outside a shared forum, so turning team mode on locks every topic its user ever kept (twelfth review); a nudge that posts the refusal into a closed topic (eighth review) |
| `a profile names its MCP servers, a non-empty prompt and an existing cwd, or is refused` | `parseProfile()` reports every problem at once: no `mcpServers`, a server entry without a `type` of `http`, `sse` or `stdio` (a command with no type is a stdio server, the SDK's own default, so a profile copied from a working `.mcp.json` boots; nineteenth review), an `http`/`sse` server without a `url` or a `stdio` one without a `command`, an empty prompt, a `cwd` that is not a directory | An empty prompt accepted (a bare Claude Code answering a group); a missing cwd accepted (the session runs in the daemon's directory); server entries passed through unread, so a typo in `url` boots clean and every topic fails to connect its only server (review, 13 Nov) |
| `an allowed tool must name a declared MCP server or a kept built-in tool` | `allowedTools` entries are `mcp__<server>__<tool>` with `<server>` in `mcpServers`, or a name in `tools`; anything else is refused. The converse holds too: every name in `tools` is in `allowedTools`, or the profile is refused. `AskUserQuestion` is refused in `tools` outright: a profile session never prompts (`dontAsk` denies it, and an allowlisted tool is auto-approved before the question could be rendered), so the model would get an empty answer (review, 13 Nov). A pattern (`*`) in `allowedTools` is refused: the hook matches exact names, so a pattern would be accepted at boot and allow nothing at the first call (security review). An empty or absent `allowedTools` is refused too: with none, every call in every topic is denied while the boot looks fine (fourteenth review) | Any name accepted: a typo in the allowlist means a bot that denies every call and nobody knows why. A kept-but-unlisted built-in accepted: the model is shown a tool the hook denies on every call. `AskUserQuestion` accepted: question-less turns that look like a silent model. A pattern accepted: a bot that denies every call from its first tool use. An empty list accepted: the same bot, from a `[]` or a misspelt key |
| `a profile's model must be one of the catalog's ids` | `profileModelProblem()` names a model that is not one of the install's catalog ids (`OPUS_MODEL` and friends), and nothing for a known one or none set (the binding's default applies); the daemon refuses to boot on it, since a model name goes to the SDK as given and a typo would otherwise boot clean and end every topic's turns in an error said without its detail (sixteenth review) | Any string accepted: every member topic dead until the operator reads the journal; none set refused, so a profile that leaves the model to the install cannot boot |
| `team mode refuses a profile without a budget` | `teamProfileProblems()` names `maxBudgetUsd` when the profile has none, `tools` when it keeps any built-in (every built-in reaches the host or the network from the box: a shell, the files with the `.env` among them, the web), and nothing otherwise; the daemon refuses to boot on it in team mode, as it does without a profile | No check: a shared forum runs with unbounded spend per topic while the docs promise a cap (review finding); a built-in kept in team mode, so every member has a shell or the host's files (eleventh review) |

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
  failed send is said; the membership lookup is capped at five seconds (an `AbortSignal`
  on the API call), so one slow API answer cannot hold every topic's updates; ♻️ Reopen
  reports when no session could open; the boot warns when the bot is not an admin of the
  forum, since `chat_member` updates reach admins only. After the third round (13 Nov): a
  topic binds without spawning a session (the first message opens it, so ten taps on 🆕
  cost ten topics and no processes); ⚙️ Controls refreshes the pinned panel itself (an edit
  of the pinned message, never a re-post, never the notice the button sat on), and 🆕 in a
  bound topic only acks; one `createProfileTopic` helper serves `/new`, 🆕 and ⚡; one
  `remainingBudget` helper serves `ensureLive` and `sendToTopic`. After the fourth round:
  an unknown slash command (`/start`, `/foo`) shows the menu in a topic and is ignored in
  General, instead of "Admins only"; a turn that ends for its budget says so at once, and
  the "switch model" hint is left off under a profile. After the fifth round: typed
  `/menu` refreshes the pinned panel the way ⚙️ does, never a re-pin. After the sixth
  round: a topic created from typed or spoken text is confirmed with a fresh message, never
  by painting over the menu another member may be looking at (the voice path runs outside
  the update loop); 🆕 in a fresh topic queues behind that topic's transcription and binds
  once; `/status` in team mode answers in General only (it lists every topic); under a
  profile, attaching or resuming an old transcript into a new topic is refused, since its
  saved total would be read as this topic's spend; the command set lives in one table
  (`commands.ts`) that the gate, the switch and the published menu all read.
- **Attaching an old session under a profile.** Refused rather than accounted for: the
  transcript may hold tool results from a full session, and its saved cost is not this
  topic's. Every profile topic starts fresh, bindings from before the profile included
  (the row above). After the seventh round: in team mode the status screen is the reduced
  one (counts, uptime, profile name; no admin ids, no topic titles, no error strings, which
  stay in the journal and `health.json`), and `/status` is published to the forum's
  administrators only; ⚙️ and `/menu` share one `controlsOrMenu` path. After the eighth
  round: the reduced screen is safe anywhere, so the in-topic refusal went; the title cap
  is `TITLE_MAX` in one place; one `mediaRefusedUnderProfile` guard serves the three media
  handlers; a failed topic creation shows members the hint and logs the error, not
  Telegram's raw text. After the ninth round: outside team mode the boot clears any
  `closed` flag team mode left behind, so it does not outlive the mode. After the tenth:
  `/status` is in no published menu in team mode, since Telegram's administrators are not
  `ADMIN_USER_IDS` (a scope for them offered some a command that refused them and hid it
  from others); one `describeError` and one `editOutcome` serve the status transport and
  the panel refresh, which re-posts (and so re-pins) only a panel that is gone, never on a
  429 or a network error; a post made as the group is told once per topic why it gets no
  answer, since the same admin's taps carry their account and work; a fresh team-mode
  topic is bound before the typed kind is read, so `feed on` or `wrap` as a first line
  meets the topic any other first line would have created; the text-only notice promises
  transcription only when `TRANSCRIBE_CMD` is set; the no-session hint offers `/attach`
  only without a profile; the "bound meanwhile" refund in `bindFreshProfileTopic` went,
  unreachable under the per-topic ordering every caller runs in. After the eleventh (and
  the security read): `topicIdOf` reads `is_topic_message`, since a reply in General
  carries a `message_thread_id` of its own and would otherwise bind and pay for a topic
  that is not there; the anonymous-post notice is team mode's; media in General gets no
  reply in team mode; a voice note is downloaded only when `TRANSCRIBE_CMD` is set and
  fewer than two transcriptions run, the audio is removed once heard, and under a profile
  a failed note or turn is said without its detail (the transcriber's stderr and the
  CLI's errors name host paths; the log has them); `/status` is in no published menu;
  the `closed` boot sweep went with `honourClosed`; the full status screen lost a dead
  team-mode branch. Accepted, not changed: built-in tool names are passed to the SDK as
  given (a list of them pinned here rots with every SDK release; team mode keeps none
  anyway); one small registry write per result keeps the spend record at most one turn
  behind a crash; the first writer into a topic made by hand in Telegram pays its
  opening; the pinned panel's pin stays loud, since main observed that a silent pin does
  not show mobile Telegram's per-topic pin bar. After the thirteenth (and the second
  security read): the bot's own refusal notices ("Admins only", the quota, the text-only
  and voice notices, an unknown command's menu in team mode) go through the same
  once-a-minute-per-topic throttle as the manager's; in team mode a second voice note into
  a topic whose note is still being transcribed is refused rather than queued, so a run of
  notes cannot hold the topic and both slots for hours; ♻️ Reopen in team mode clears the
  flag and opens nothing (a reopened topic costs no process until someone writes in it),
  and elsewhere names the real refusal instead of guessing "budget spent?"; the three
  topic-creation failure texts are one, with Telegram's error in the log; the status
  screen's header is built once for both branches; the rotator's account label stays out
  of a shared forum ("continuing now"); the rate-limit notice under a profile no longer
  offers a model switch; the README notes that the MCP config, bearer header included,
  rides on the session's command line. Not changed: `assistantError` carries the SDK's
  error enum, not free text, so it stays as it is (the thirteenth round's claim was wrong
  on the facts, as the second security read confirmed); the membership lookup stays on
  the update loop, bounded by its five-second abort (recorded trade-off, now with the
  flood class closed by the throttle). After the fourteenth: a typed `/menu`, an unknown
  command or plain text in General sends the menu fresh instead of painting it over the
  last tapped menu, which in a shared forum is another member's screen; `topicTitleOf`
  reads the bot's message a tap sits on, so a topic bound from 🆕 keeps its name; a
  forwarded note or audio file into a fresh team-mode topic binds (and pays its opening)
  before any download; the anonymous-post notice covers "Send as" a channel; the README's
  pause sentence names the stuck bound it had omitted. After the fifteenth (and the third
  security read): the bot's replies a member can trigger at will are keyed by topic and
  kind (one refusal no longer mutes a different one) and by sender (ten a minute), with
  the help text, the typed menu, the `m:help` tap and the wrap-up "nothing running" reply
  on the same rule; a forwarded note binds its fresh topic only after the refusals that
  cost nothing, so a refused note costs no opening; `paint` edits only a message whose
  own keyboard holds the tapped data, which Telegram sets and a client cannot forge, so
  forged callback data paints nothing over the pinned panel or a colleague's notice; the
  rate-limit notice under `shared` names no rotator. Refuted and unchanged: the remainder
  handed to a resumed stretch (the premise), and a quota reservation straddling midnight,
  which the day's reset makes moot (the counter starts over, so an unrefunded reservation
  from yesterday shortens nothing). After the sixteenth (and the hook): the sender's
  allowance is checked before the topic's slot, so a member past theirs cannot silence a
  notice for a colleague; every reply a member can trigger carries the sender, the
  manager's refusals included (`sendToTopic` takes the sender and the manager consults
  the bot's one rule through `replyAllowed` in its deps, its own throttle only without
  it); a member's own voice note into a fresh team-mode topic binds before any download,
  as the forwarded one already did; `attach()` says the one creation-failure text; the
  notice for a turn ended as stuck says the unfinished turn and what was sent during it
  are lost, the earlier context kept; the SDK's two budget numbers (`maxBudgetUsd` per
  query, `total_cost_usd` cumulative) are pinned in a comment at the hand-off, after
  three rounds read them as one. Refuted again, unchanged: that hand-off. After the
  seventeenth (and the fourth security read): ▶️ Resume ignores a pre-profile binding's
  hand-off, which `ensureLive` dropped only after the tap had read it, and carries the
  sender; the wrap-up confirmation, the `m:tw:*` refusal, feed flips (tap and typed), a
  forged or stale tap's fallback, topic creation attempts and a broken model's error
  notices are on the one rule too (the budget notice never muted); outside team mode the
  rule answers everything; the manager's own throttle went, `replyAllowed` being
  required; Close & keep writes the flag in team mode only, keeps the panel pinned in its
  closed state with ♻️ Reopen, and Reopen refreshes it rather than re-pinning; for one
  user ⚙️ and `/menu` bring the panel to the bottom as on main; the misplaced docblock
  sits on `teamProfileProblems` again. Accepted, recorded: idle eviction applies the
  stuck bound as cap pressure does, which the operator sets above the longest tool.
  After the eighteenth: the "could not verify" notice is on the reply rule; Close & keep
  writes the flag before anything yields, so a note still being heard cannot open a
  session in the gap; a topic deleted this process is remembered, so such a note cannot
  bind it again while Telegram removes it; a second voice note waits for a transcription
  in that topic, not for anything else queued there; when the panel's edit fails for a
  429 or the network, the current state goes out as an unpinned copy, so a closed topic
  is never without its Reopen button; `createTopic` logs its own failure and its four
  callers only reply; the redundant team-mode prefixes before `replyAllowed` went; the
  stale comment on the closed flag is corrected. Refuted with the plugin's source:
  `@grammyjs/auto-retry`'s `pause` rejects on the abort signal, so the five-second cap
  bounds a 429's wait on the membership lookup too. After the nineteenth: a server
  entry with a command and no type is a stdio server (the SDK's default and every
  `.mcp.json`'s shape); the `m:menu` and `m:ctl` taps are on the rule; a typed `/menu` or
  the controls tap whose panel is already current shows an unpinned copy or says where the
  panel is, instead of nothing; an inaccessible callback message (too old for Telegram to
  hand over) is not a forged tap; a member's topic creations have their own ten-a-minute
  allowance, apart from replies and with admins exempt; the nine muted-reply pairs are one
  `muted()` helper, the feed tap counted like the rest. Kept: the transcription slot is
  reserved before the bind (the hook's requirement: no await between the check and the
  reservation), at the cost of a slot held through a few Telegram calls. The fifth
  security read confirmed the fourth's two closures and added: the "too large" and "not
  transcribed" voice replies on the rule; the "paused to free a slot" notice, which lands
  on a colleague's topic, on the rule too; a stored hand-off capped at one message, since
  the registry is rewritten whole per result; and a README line to set
  `ROTATOR_HANDOFF=off` in team mode. Not done: preferring a member's own idle sessions as
  the cap's victims, since topics have no owner.
- **The membership lookup runs on the update loop.** grammY handles updates one at a time,
  and `admit()` asks the forum before a message is queued, so a cache miss costs every
  topic that lookup (bounded at five seconds, deduplicated per sender). Moving it into the
  per-topic queue would give up the ordering guarantee the queue is built on; measured
  lookups are a few hundred milliseconds, so this stays until a run shows otherwise.
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
