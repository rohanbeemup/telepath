/**
 * Configuration: the state directory's .env plus the process environment, parsed and
 * validated into one typed object. Every problem is reported together, so a fresh
 * install is fixed in one edit rather than one restart per missing key.
 */
import { homedir } from 'os'
import { dirname, join } from 'path'
import { buildCatalog, parseEffort, type Catalog, type Effort } from './models'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export type Config = {
  stateDir: string
  telegramToken: string
  allowedUserId: string
  forumChatId: string
  defaultCwd: string
  reposDir: string
  catalog: Catalog
  defaultModel: string
  defaultEffort?: Effort
  idleMinutes: number
  maxLiveSessions: number
  logLevel: LogLevel
  /** Optional override; the SDK's bundled binary is the default. */
  claudeBinary?: string
}

export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`telepath configuration:\n  - ${problems.join('\n  - ')}`)
    this.name = 'ConfigError'
  }
}

/** `KEY=value` per line; `#` lines and blanks ignored; values trimmed. Pure. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(\w+)\s*=\s*(.*)$/)
    if (m) out[m[1]] = m[2].trim()
  }
  return out
}

/** The shell wins over the file: a per-run override must stay possible. */
export function mergeEnvFile(env: Record<string, string | undefined>, file: Record<string, string>): void {
  for (const [k, v] of Object.entries(file)) if (env[k] === undefined) env[k] = v
}

const LOG_LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error']

export function parseConfig(env: Record<string, string | undefined>, stateDir: string): Config {
  const problems: string[] = []
  const req = (name: string): string => {
    const v = env[name]
    if (!v) problems.push(`${name} is required (set it in ${join(stateDir, '.env')})`)
    return v ?? ''
  }
  const num = (name: string, dflt: number): number => {
    const raw = env[name]
    if (raw === undefined || raw === '') return dflt
    const n = Number(raw)
    if (!Number.isFinite(n) || n <= 0) problems.push(`${name} must be a positive number, got "${raw}"`)
    return n
  }

  const telegramToken = req('TELEGRAM_BOT_TOKEN')
  const allowedUserId = req('ALLOWED_USER_ID')
  const forumChatId = req('FORUM_CHAT_ID')

  const defaultCwd = env.DEFAULT_CWD || homedir()
  const reposDir = env.REPOS_DIR || dirname(defaultCwd)

  const catalog = buildCatalog({
    ids: {
      haiku: env.HAIKU_MODEL || 'claude-haiku-4-5',
      sonnet: env.SONNET_MODEL || 'claude-sonnet-5',
      opus: env.OPUS_MODEL || 'claude-opus-5',
      fable: env.FABLE_MODEL || 'claude-fable-5-1',
    },
    enabled: (env.ENABLED_MODELS || 'sonnet,opus').split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
  })

  let defaultModel = env.DEFAULT_MODEL || catalog.ids.sonnet
  if (!catalog.enabled.some(k => catalog.ids[k] === defaultModel)) defaultModel = catalog.ids[catalog.enabled[0]]

  let defaultEffort: Effort | undefined
  if (env.DEFAULT_EFFORT) {
    defaultEffort = parseEffort(env.DEFAULT_EFFORT)
    if (!defaultEffort) problems.push(`DEFAULT_EFFORT must be one of low, medium, high, xhigh, max; got "${env.DEFAULT_EFFORT}"`)
  }

  const idleMinutes = num('IDLE_MINUTES', 15)
  const maxLiveSessions = num('MAX_LIVE_SESSIONS', 3)

  const rawLevel = (env.LOG_LEVEL || 'info').toLowerCase()
  const logLevel = (LOG_LEVELS as string[]).includes(rawLevel) ? (rawLevel as LogLevel) : 'info'
  if (!(LOG_LEVELS as string[]).includes(rawLevel)) problems.push(`LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}; got "${env.LOG_LEVEL}"`)

  if (problems.length) throw new ConfigError(problems)

  return {
    stateDir,
    telegramToken,
    allowedUserId,
    forumChatId,
    defaultCwd,
    reposDir,
    catalog,
    defaultModel,
    defaultEffort,
    idleMinutes,
    maxLiveSessions,
    logLevel,
    claudeBinary: env.CLAUDE_BINARY || undefined,
  }
}
