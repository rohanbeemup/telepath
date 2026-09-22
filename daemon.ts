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
 * Auth: subscription (inherits the user's `claude login`; no API key).
 * State: <state-dir>/.env, registry.json, prefs.json, outbox/, inbox/, health.json —
 * <state-dir> defaults to this file's directory (override TG_CLAUDE_STATE_DIR).
 */
import { chmodSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { TelegramBot } from './src/bot'
import { ConfigError, mergeEnvFile, parseConfig, parseEnvFile, type Config } from './src/config'
import { Files } from './src/files'
import { ErrorRing, Logger, Metrics } from './src/log'
import { bundledClaudePath, checkClaudeVersion, MIN_CLAUDE_VERSION, readClaudeVersion } from './src/preflight'
import { handOffToRotator, rotatorActive, rotatorEnabled, waitForRotation } from './src/rotator'
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

// ── wiring ──────────────────────────────────────────────────────────────────
const backend = new SdkBackend({ settingSources: ['user', 'project', 'local'], pathToClaudeCodeExecutable: cfg.claudeBinary, log })

const CHILD_ENV: Record<string, string | undefined> = { ...process.env }

function statusText(): string {
  const up = Math.round((Date.now() - STARTED) / 60000)
  const snap = metrics.snapshot()
  const liveList = [...topics.live.values()].map(l => `• ${store.registry[l.topicId]?.title ?? l.topicId} — ${l.model}${isBusy(l) ? ` (running, ${l.inFlight} in flight)` : ''}`)
  const errors = ring.list().slice(-5).map(e => `• ${new Date(e.at).toISOString().slice(11, 19)} ${e.ev}${e.message ? `: ${e.message.slice(0, 120)}` : ''}`)
  const counters = Object.entries(snap).map(([k, v]) => `${k}=${v}`).join('  ')
  return (
    `📊 telepath ${VERSION} · SDK ${SDK_VERSION} · ${versionVerdict.message}\n` +
    `up ${up} min · ${topics.live.size}/${cfg.maxLiveSessions} live · ${Object.keys(store.registry).length} topics bound · idle ${cfg.idleMinutes}m\n` +
    `default ${store.prefs.defaultModel} @ ${store.prefs.defaultEffort ?? 'default'} · models ${cfg.catalog.enabled.join(',')} · rotator ${rotatorEnabled() ? 'on' : 'off'}\n\n` +
    (liveList.length ? `Live:\n${liveList.join('\n')}\n\n` : '') +
    (counters ? `Counters: ${counters}\n\n` : '') +
    (errors.length ? `Recent errors:\n${errors.join('\n')}` : 'No errors recorded.')
  )
}

const bot = new TelegramBot({ cfg, store, files, log, metrics, statusText })

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
})
bot.attachTopics(topics)

// ── periodic work ───────────────────────────────────────────────────────────
setInterval(() => topics.evictIdle(), 60_000).unref()

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
  await bot.bot.api.setMyCommands([
    { command: 'menu', description: 'Open the menu — everything is buttons' },
    { command: 'status', description: 'Live sessions, counters, versions' },
  ])
  log.info('telepath.up', {
    version: VERSION,
    sdk: SDK_VERSION,
    bot: me.username,
    chat: cfg.forumChatId,
    user: cfg.allowedUserId,
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
bot.bot.start({ onStart: i => log.info('telegram.polling', { as: i.username }) })
