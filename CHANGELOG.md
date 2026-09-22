# Changelog

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
- **Feed and task events.** Background task starts and completions come from the SDK's
  own `task_started` / `task_notification` events; the activity feed batches lines per
  topic within Telegram's rate limit.
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
