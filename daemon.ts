#!/usr/bin/env bun
/**
 * telepath — Telegram forum-topic ⇄ resident Claude Code session multiplexer.
 *
 * One dedicated bot owns one Telegram forum supergroup. Each forum topic is bound to one
 * resident Claude Code session (Agent SDK `query()` with streaming input). Per-tool
 * permission prompts are posted as Allow/Deny buttons INTO that topic and the session
 * blocks on the tap, so concurrent approvals are partitioned by thread.
 *
 * This file is the bootstrap only: config → log → state → preflight → backend →
 * topics → bot. Behaviour lives in src/ and is tested there.
 *
 * Auth: the Claude Code child's own — the user's `claude login`, or an ANTHROPIC_API_KEY
 * in .env, which reaches the child like the rest of the daemon's environment.
 * State: <state-dir>/.env, registry.json, prefs.json, outbox/, inbox/, health.json —
 * <state-dir> defaults to this file's directory (override TG_CLAUDE_STATE_DIR).
 */
import { chmodSync, readFileSync, statSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { API_CONSTANTS } from 'grammy'
import { TelegramBot } from './src/bot'
import { COMMANDS } from './src/commands'
import { ConfigError, mergeEnvFile, parseConfig, parseEnvFile, type Config } from './src/config'
import { Files, transcriptExists } from './src/files'
import { ErrorRing, Logger, Metrics } from './src/log'
import { bundledClaudePath, checkClaudeVersion, MIN_CLAUDE_VERSION, readClaudeVersion } from './src/preflight'
import { parseProfile, ProfileError, profileModelProblem, teamProfileProblems, type Profile } from './src/profile'
import { handOffToRotator, rotatorActive, rotatorEnabled, waitForRotation } from './src/rotator'
import { drainSeedRequests } from './src/seed'
import { SdkBackend } from './src/session'
import { loadStore, StateError } from './src/state'
import { TopicManager, isBusy } from './src/topics'

const VERSION = (JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }).version
const SDK_VERSION = (JSON.parse(readFileSync(new URL('./node_modules/@anthropic-ai/claude-agent-sdk/package.json', import.meta.url), 'utf8')) as { version: string }).version
const STARTED = Date.now()

// ── config ─────────────────────────────────────────────────────────────────
const stateDir = process.env.TG_CLAUDE_STATE_DIR || import.meta.dir
const envFile = join(stateDir, '.env')
try {
  chmodSync(envFile, 0o600) // it holds the bot token (a no-op on NTFS)
  mergeEnvFile(process.env, parseEnvFile(readFileSync(envFile, 'utf8')))
} catch {}

let cfg: Config
try {
  cfg = parseConfig(process.env, stateDir)
} catch (e) {
  if (e instanceof ConfigError) {
    process.stderr.write(e.message + '\n')
    process.exit(2)
  }
  throw e
}

// ── log & metrics ───────────────────────────────────────────────────────────
const ring = new ErrorRing(20)
const log = new Logger({ level: cfg.logLevel, pretty: process.env.LOG_FORMAT === 'pretty' || (process.env.LOG_FORMAT !== 'json' && !!process.stderr.isTTY), ring })
const metrics = new Metrics()

process.on('unhandledRejection', e => {
  metrics.inc('unhandled_rejections')
  log.error('process.unhandled_rejection', { error: e })
})
process.on('uncaughtException', e => {
  metrics.inc('uncaught_exceptions')
  log.error('process.uncaught_exception', { error: e })
})

// ── state ───────────────────────────────────────────────────────────────────
let store: ReturnType<typeof loadStore>
try {
  store = loadStore(stateDir, { defaultModel: cfg.defaultModel, defaultCwd: cfg.defaultCwd, defaultEffort: cfg.defaultEffort }, cfg.catalog)
} catch (e) {
  if (e instanceof StateError) {
    // A registry that does not parse is preserved, never replaced: exit and say so.
    log.error('state.unreadable', { file: e.file, message: e.message })
    process.exit(2)
  }
  throw e
}
const files = new Files(stateDir)

// ── preflight ───────────────────────────────────────────────────────────────
const claudeBin = cfg.claudeBinary ?? bundledClaudePath(import.meta.dir)
const claudeVersionRaw = claudeBin ? await readClaudeVersion(claudeBin) : undefined
const versionVerdict = checkClaudeVersion(claudeVersionRaw, MIN_CLAUDE_VERSION)
if (!versionVerdict.ok) log.warn('preflight.claude_version', { message: versionVerdict.message, binary: claudeBin ?? '(sdk default)' })
else log.info('preflight.claude_version', { message: versionVerdict.message, binary: claudeBin ?? '(sdk default)' })

// ── session profile ─────────────────────────────────────────────────────────
// The locked shape every session runs with (required in team mode). It may hold a bearer
// header for its MCP servers, so it is kept private like .env; a profile that does not
// parse stops the boot with every problem listed, never a bot with fewer limits than asked.
let profile: Profile | undefined
if (cfg.profileFile) {
  try {
    chmodSync(cfg.profileFile, 0o600)
  } catch {}
  try {
    profile = parseProfile(JSON.parse(readFileSync(cfg.profileFile, 'utf8')), {
      dir: dirname(cfg.profileFile),
      readFile: p => readFileSync(p, 'utf8'),
      isDirectory: p => {
        try {
          return statSync(p).isDirectory()
        } catch {
          return false
        }
      },
    })
  } catch (e) {
    process.stderr.write((e instanceof ProfileError ? e.message : `session profile ${cfg.profileFile}: ${e instanceof Error ? e.message : String(e)}`) + '\n')
    process.exit(2)
  }
  // A model name goes to the SDK as given: a typo would boot clean and end every turn in an error.
  const modelProblem = profileModelProblem(profile, cfg.catalog.enabled.map(k => cfg.catalog.ids[k])) // enabled ones: a disabled model is the operator's choice too
  if (modelProblem) {
    process.stderr.write(`session profile ${cfg.profileFile}:\n  - ${modelProblem}\n`)
    process.exit(2)
  }
  if (cfg.teamMode) {
    const problems = teamProfileProblems(profile)
    if (problems.length) {
      process.stderr.write(`session profile ${cfg.profileFile}, in team mode:\n  - ${problems.join('\n  - ')}\n`)
      process.exit(2)
    }
  }
}

// ── wiring ──────────────────────────────────────────────────────────────────
const backend = new SdkBackend({ settingSources: ['user', 'project', 'local'], pathToClaudeCodeExecutable: cfg.claudeBinary, log, profile })

const CHILD_ENV: Record<string, string | undefined> = { ...process.env }

function statusText(): string {
  const up = Math.round((Date.now() - STARTED) / 60000)
  const snap = metrics.snapshot()
  const head =
    `📊 telepath ${VERSION} · SDK ${SDK_VERSION} · ${versionVerdict.message}\n` +
    `up ${up} min · ${topics.live.size}/${cfg.maxLiveSessions} live · ${Object.keys(store.registry).length} topics bound · idle ${cfg.idleMinutes}m\n`
  // Team mode: the forum reads this, so no admin ids, no topic titles, no error strings
  // (those stay in the journal and health.json); counts only.
  if (cfg.teamMode) {
    return (
      head +
      `team mode · ${profile ? `profile ${profile.name} (${profile.allowedTools.length} tools)` : 'no profile'} · ${cfg.teamTopicsPerDay} topics per member per day\n` +
      `turns ${snap.turns ?? 0} · errors ${snap.turn_errors ?? 0} (details in the journal)`
    )
  }
  const liveList = [...topics.live.values()].map(l => `• ${store.registry[l.topicId]?.title ?? l.topicId} — ${l.model}${isBusy(l) ? ` (running${l.queued ? `, ${l.queued} queued` : ''})` : ''}`)
  const errors = ring.list().slice(-5).map(e => `• ${new Date(e.at).toISOString().slice(11, 19)} ${e.ev}${e.message ? `: ${e.message.slice(0, 120)}` : ''}`)
  const counters = Object.entries(snap).map(([k, v]) => `${k}=${v}`).join('  ')
  return (
    head +
    `default ${store.prefs.defaultModel} @ ${store.prefs.defaultEffort ?? 'default'} · models ${cfg.catalog.enabled.join(',')} · rotator ${rotatorEnabled() ? 'on' : 'off'}\n` +
    `${profile ? `profile ${profile.name} (${profile.allowedTools.length} tools)` : 'no profile'}\n\n` +
    (liveList.length ? `Live:\n${liveList.join('\n')}\n\n` : '') +
    (counters ? `Counters: ${counters}\n\n` : '') +
    (errors.length ? `Recent errors:\n${errors.join('\n')}` : 'No errors recorded.')
  )
}

const bot = new TelegramBot({ cfg, store, files, log, metrics, statusText, profile })

const topics = new TopicManager({
  store,
  catalog: cfg.catalog,
  idleMinutes: cfg.idleMinutes,
  maxLiveSessions: cfg.maxLiveSessions,
  backend,
  baseEnv: () => CHILD_ENV,
  outboxDir: t => files.outboxDir(t),
  extras: t => bot.extras(t),
  say: (t, text) => bot.say(t, text),
  onEvent: (t, ev) => bot.onEvent(t, ev),
  rotator: { enabled: rotatorEnabled, active: rotatorActive, handOff: handOffToRotator, waitForRotation: b => waitForRotation(b) },
  log,
  metrics,
  primeContract: !profile,
  budgetUsd: profile?.maxBudgetUsd,
  profileSessions: !!profile, shared: cfg.teamMode, stuckTurnMs: cfg.stuckTurnMinutes * 60_000, replyMuted: (t, k, s) => bot.muted(t, k, s), transcriptExists,
})
bot.attachTopics(topics)
// Bindings from the other side of the profile line become this side's in one pass, so no reader
// sees their old session, hand-off or approval mode, and outside team mode every `closed` flag a
// team-mode run left is cleared; the manager adopts any binding added since on its first open.
topics.adoptAll()

// ── periodic work ───────────────────────────────────────────────────────────
setInterval(() => topics.evictIdle(), 60_000).unref()
// A todo-queue run drops a seed-request per finished item; bind each to its session so it
// can be continued by typing in the topic. Binding only (the topic already exists); paint controls.
// Under a profile the requests are refused and consumed: the profile owns every session.
const seedDir = join(stateDir, 'seed-requests')
setInterval(() => {
  try {
    for (const id of drainSeedRequests(seedDir, store, Date.now, log, !!profile)) {
      metrics.inc('seed_bindings')
      void bot.postPinnedControls(id)
    }
  } catch (e) {
    log.warn('seed.drain_failed', { error: e })
  }
}, 5_000).unref()
// The live status messages: typing while a turn runs, an edit at most every 12 s per topic.
setInterval(() => void bot.status.tick().catch(e => log.warn('status.tick_failed', { error: e })), 1_000).unref()

function writeHealth(): void {
  try {
    writeFileSync(
      join(stateDir, 'health.json'),
      JSON.stringify(
        {
          at: new Date().toISOString(),
          version: VERSION,
          sdk: SDK_VERSION,
          claude: versionVerdict,
          uptimeSec: Math.round((Date.now() - STARTED) / 1000),
          live: topics.live.size,
          bound: Object.keys(store.registry).length,
          counters: metrics.snapshot(),
          recentErrors: ring.list().slice(-5),
        },
        null,
        2,
      ) + '\n',
    )
  } catch (e) {
    log.warn('health.write_failed', { error: e })
  }
}
setInterval(writeHealth, 60_000).unref()

// ── shutdown ────────────────────────────────────────────────────────────────
let shuttingDown = false
function shutdown(sig: string): void {
  if (shuttingDown) return
  shuttingDown = true
  log.info('process.shutdown', { signal: sig, live: topics.live.size })
  topics.closeAll(`shutdown (${sig})`)
  try {
    bot.bot.stop()
  } catch {}
  writeHealth()
  process.exit(0)
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

// ── boot ────────────────────────────────────────────────────────────────────
try {
  const me = await bot.bot.api.getMe()
  if (cfg.teamMode) {
    // chat_member updates reach admins only; without them a removed member keeps access until the TTL,
    // and topics are created with Manage Topics. Refused, not warned (twenty-eighth review): the forum
    // would run with fewer limits than asked, as with a profile problem, and the fix is one Telegram
    // setting. A lookup that fails is unknown, not a no: the boot goes on, said.
    try {
      const self = await bot.bot.api.getChatMember(cfg.forumChatId, me.id)
      if (self.status !== 'administrator' && self.status !== 'creator') {
        process.stderr.write(`team mode: the bot is "${self.status}" in ${cfg.forumChatId}, not an admin. Make it an admin of the forum with Manage Topics: topics are created with it, and chat_member updates, which end a removed member's cached access early, reach admin bots only.\n`)
        process.exit(2)
      }
    } catch (e) {
      log.warn('preflight.bot_membership_unknown', { error: e })
    }
  }
  // The published menu reads the one command table (src/commands.ts), like the gate and the
  // handler. In team mode everyone sees new, menu and help (the member actions with a typed form),
  // and /status, an admin's, is in no menu: Telegram's administrators are not ADMIN_USER_IDS, so a
  // scope for them would offer some a command that refuses them and hide it from others. Admins
  // have it from the README.
  const publish = (names: string[]) => names.map(command => ({ command, description: COMMANDS[command] }))
  await bot.bot.api.setMyCommands(publish(cfg.teamMode ? ['new', 'menu', 'help'] : ['menu', 'status']))
  log.info('telepath.up', {
    version: VERSION,
    sdk: SDK_VERSION,
    bot: me.username,
    chat: cfg.forumChatId,
    user: cfg.allowedUserId,
    teamMode: cfg.teamMode,
    admins: cfg.adminUserIds,
    profile: profile ? { name: profile.name, servers: Object.keys(profile.mcpServers), allowedTools: profile.allowedTools.length, tools: profile.tools.length } : null,
    defaultModel: store.prefs.defaultModel,
    defaultEffort: store.prefs.defaultEffort ?? 'default',
    models: cfg.catalog.enabled.join(','),
    cap: cfg.maxLiveSessions,
    idleMin: cfg.idleMinutes,
    stateDir,
  })
} catch (e) {
  log.error('telepath.boot_failed', { error: e, hint: 'check TELEGRAM_BOT_TOKEN and network' })
  process.exit(3)
}
writeHealth()
// chat_member updates are off by default; team mode's membership cache is cleared by them.
bot.bot.start({ allowed_updates: [...API_CONSTANTS.DEFAULT_UPDATE_TYPES, 'chat_member'], onStart: i => log.info('telegram.polling', { as: i.username }) })
