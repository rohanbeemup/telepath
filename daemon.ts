#!/usr/bin/env bun
/**
 * Telegram forum-topic ⇄ resident Claude Code session multiplexer.
 *
 * One dedicated bot owns one Telegram forum supergroup. Each forum *topic* is
 * bound to one resident Claude Code session (Agent SDK, unstable v2). Per-tool
 * permission prompts are posted as Allow/Deny buttons INTO that topic and the
 * session blocks on the tap — so concurrent approvals are partitioned by thread.
 *
 * Auth: subscription (inherits the user's `claude login` credentials; no API key).
 * State: <state-dir>/.env (config) + registry.json (topic_id → session binding),
 * where <state-dir> defaults to this file's directory (override TG_CLAUDE_STATE_DIR).
 *
 * NOTE: relies on @anthropic-ai/claude-agent-sdk `unstable_v2_*` API (@alpha) — pin the version.
 */
import {
  unstable_v2_createSession,
  unstable_v2_resumeSession,
  listSessions,
  type SDKSession,
  type SDKMessage,
  type PermissionResult,
  type SettingSource,
} from '@anthropic-ai/claude-agent-sdk'
import { Bot, InlineKeyboard, InputFile, type Context } from 'grammy'
import { htmlEsc, htmlToPlain, renderWithDeadline, chunkHtml } from './markdown'
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync, statSync, chmodSync, readdirSync, rmSync } from 'fs'
import { homedir } from 'os'
import { join, dirname, basename } from 'path'

// ── Config ────────────────────────────────────────────────────────────────
// State (.env, registry.json) lives beside the daemon by default so a fresh
// clone runs in place; override with TG_CLAUDE_STATE_DIR.
const STATE_DIR = process.env.TG_CLAUDE_STATE_DIR || import.meta.dir
const REGISTRY_FILE = join(STATE_DIR, 'registry.json')
const INBOX_DIR = join(STATE_DIR, 'inbox') // downloaded images land here

function loadEnv(): void {
  const envFile = join(STATE_DIR, '.env')
  try {
    chmodSync(envFile, 0o600) // it holds the bot token — lock to owner
    for (const line of readFileSync(envFile, 'utf8').split('\n')) {
      const m = line.match(/^\s*(\w+)\s*=\s*(.*)$/)
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim()
    }
  } catch {}
}
loadEnv()

const TOKEN = req('TELEGRAM_BOT_TOKEN')
const ALLOWED_USER_ID = req('ALLOWED_USER_ID')
const FORUM_CHAT_ID = req('FORUM_CHAT_ID')
const DEFAULT_CWD = process.env.DEFAULT_CWD || homedir()
const HAIKU_MODEL = process.env.HAIKU_MODEL || 'claude-haiku-4-5'
const SONNET_MODEL = process.env.SONNET_MODEL || 'claude-sonnet-5'
const OPUS_MODEL = process.env.OPUS_MODEL || 'claude-opus-5'
const FABLE_MODEL = process.env.FABLE_MODEL || 'claude-fable-5-1'
const MODELS: Record<string, string> = { haiku: HAIKU_MODEL, sonnet: SONNET_MODEL, opus: OPUS_MODEL, fable: FABLE_MODEL }
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || SONNET_MODEL
// Effort (reasoning depth) per session. The v2 session API has no `effort`
// option, but the claude binary reads CLAUDE_CODE_EFFORT_LEVEL from its
// environment and lets it override the settings-file level for that process
// only — so each topic's session gets its own value via `env`.
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
type Effort = (typeof EFFORT_LEVELS)[number]
function parseEffort(s: string | undefined): Effort | undefined {
  const v = s?.trim().toLowerCase()
  return (EFFORT_LEVELS as readonly string[]).includes(v ?? '') ? (v as Effort) : undefined
}
// Unset = let Claude Code decide (its settings / built-in default).
const DEFAULT_EFFORT = parseEffort(process.env.DEFAULT_EFFORT)
// Haiku 4.5 rejects effort levels; every other package accepts low…max.
const EFFORT_MODELS = new Set(['sonnet', 'opus', 'fable'])
const IDLE_MINUTES = Number(process.env.IDLE_MINUTES || 15)
const MAX_LIVE_SESSIONS = Number(process.env.MAX_LIVE_SESSIONS || 3)
const SETTING_SOURCES: SettingSource[] = ['user', 'project', 'local']

// The SDK's platform-binary resolution can pick the wrong libc variant (e.g. musl
// on a glibc box) when bun installs all optional deps. Pin the matching binary
// the SDK shipped (in this package's node_modules); allow override via
// CLAUDE_BINARY; fall back to an installed `claude` on PATH.
function resolveClaudeBin(): string {
  const override = process.env.CLAUDE_BINARY
  if (override && existsSync(override)) return override
  const isWin = process.platform === 'win32'
  const exe = isWin ? 'claude.exe' : 'claude'
  const variants = isWin
    ? ['claude-agent-sdk-win32-x64', 'claude-agent-sdk-win32-arm64']
    : [
        'claude-agent-sdk-linux-x64', 'claude-agent-sdk-linux-x64-musl',
        'claude-agent-sdk-linux-arm64', 'claude-agent-sdk-darwin-x64', 'claude-agent-sdk-darwin-arm64',
      ]
  for (const v of variants) {
    const p = join(import.meta.dir, 'node_modules', '@anthropic-ai', v, exe)
    if (existsSync(p)) return p
  }
  return exe // rely on PATH
}
const CLAUDE_BIN = resolveClaudeBin()

// Read-only tools auto-run; everything else (Bash/Write/Edit/Web/Task/…) prompts.
const AUTO_ALLOW = new Set(['Read', 'Glob', 'Grep', 'LS', 'NotebookRead', 'TodoWrite'])

function req(name: string): string {
  const v = process.env[name]
  if (!v) {
    process.stderr.write(`telepath: ${name} is required (set in ${STATE_DIR}/.env)\n`)
    process.exit(1)
  }
  return v
}

// ── Registry (persisted topic → session binding) ────────────────────────────
type Binding = { sessionId?: string; cwd: string; model: string; effort?: Effort; title: string; lastActive: number; auto?: boolean; controlMsgId?: number }
type Registry = Record<string, Binding> // keyed by topic_id (string)

function loadRegistry(): Registry {
  try {
    return JSON.parse(readFileSync(REGISTRY_FILE, 'utf8'))
  } catch {
    return {}
  }
}
function saveRegistry(): void {
  mkdirSync(STATE_DIR, { recursive: true })
  const tmp = REGISTRY_FILE + '.tmp'
  writeFileSync(tmp, JSON.stringify(registry, null, 2) + '\n')
  renameSync(tmp, REGISTRY_FILE)
}
const registry: Registry = loadRegistry()

// ── Prefs (persisted defaults for new sessions, set via Settings menu) ──────
// Root to scan for repos in the folder picker (defaults to the parent of
// DEFAULT_CWD — e.g. ~/code when DEFAULT_CWD is ~/code/my-project).
const REPOS_DIR = process.env.REPOS_DIR || dirname(DEFAULT_CWD)
type Prefs = { defaultModel: string; defaultCwd: string; defaultEffort?: Effort }
const PREFS_FILE = join(STATE_DIR, 'prefs.json')
function loadPrefs(): Prefs {
  const base: Prefs = { defaultModel: DEFAULT_MODEL, defaultCwd: DEFAULT_CWD, defaultEffort: DEFAULT_EFFORT }
  try {
    const raw = JSON.parse(readFileSync(PREFS_FILE, 'utf8'))
    const saved: Prefs = { ...base, ...raw }
    // A cleared default is persisted as null (JSON drops undefined), so "key
    // present" means the user chose, even when the choice was "default"; only
    // an absent key falls back to DEFAULT_EFFORT from .env.
    saved.defaultEffort = 'defaultEffort' in raw ? parseEffort(raw.defaultEffort) : DEFAULT_EFFORT
    return saved
  } catch {
    return base
  }
}
const prefs = loadPrefs()
// The saved default folder can be deleted or moved between runs, so every
// consumer resolves it through here rather than handing a dead path to the SDK.
function defaultCwd(): string {
  try {
    if (statSync(prefs.defaultCwd).isDirectory()) return prefs.defaultCwd
  } catch {}
  return DEFAULT_CWD
}
function savePrefs(): void {
  try {
    mkdirSync(STATE_DIR, { recursive: true })
    const tmp = PREFS_FILE + '.tmp'
    // null, not undefined: see loadPrefs — an undefined key would vanish from
    // the file and the .env default would come back on the next boot.
    writeFileSync(tmp, JSON.stringify({ ...prefs, defaultEffort: prefs.defaultEffort ?? null }, null, 2) + '\n')
    renameSync(tmp, PREFS_FILE)
  } catch (e) {
    process.stderr.write(`prefs save failed: ${e}\n`)
  }
}

// ── Live sessions (in-memory) ───────────────────────────────────────────────
type Live = {
  session: SDKSession
  topicId: string
  model: string
  cwd: string
  lastActive: number
  pumping: boolean
}
const live = new Map<string, Live>() // topic_id → Live

// Pending permission prompts: short token → resolver. callback_data must stay < 64 bytes.
type Pending = { resolve: (r: PermissionResult) => void; topicId: string; messageId?: number }
const pending = new Map<string, Pending>()
let permCounterSeed = 0
function permToken(): string {
  permCounterSeed = (permCounterSeed + 1) % 100000
  return permCounterSeed.toString(36)
}

const bot = new Bot(TOKEN)


// ── Telegram send helpers ───────────────────────────────────────────────────
// Render Claude's GitHub-flavoured Markdown as Telegram HTML (bold,
// headings→bold, lists, code, links). Falls back to plain text if conversion
// or Telegram's entity parser rejects a chunk — so a stray character never
// drops a message. Chunk a bit smaller than the 4096 cap: escaping adds chars.
//
// The whole message is parsed ONCE and its output split. Splitting the markdown
// and parsing each piece lets a fragment be reinterpreted: a link inside a code
// fence that straddles a boundary becomes a live anchor with its destination
// hidden behind the label, and being valid HTML it sails past the fallback.
async function sayTopic(topicId: string | undefined, text: string): Promise<void> {
  const opts = topicId ? { message_thread_id: Number(topicId) } : {}
  // Rendering runs on a worker with a deadline. marked's inline lexer is
  // quadratic on long delimiter runs, and this call sits on the daemon's only
  // thread, so an unbounded parse would stall approvals for every topic, not
  // just this one. Past the deadline we send the text unformatted.
  const html = await renderWithDeadline(text, 1500)
  for (const part of chunkHtml(html ?? text, 3500)) {
    if (html) {
      try {
        await bot.api.sendMessage(FORUM_CHAT_ID, part, { ...opts, parse_mode: 'HTML' })
        process.stderr.write(`[out] sent topic ${topicId} ${part.length}c (html)\n`)
        continue
      } catch (e) {
        process.stderr.write(`[out] html rejected, retrying plain: ${e}\n`)
      }
    }
    const plain = html ? htmlToPlain(part) : part
    try {
      await bot.api.sendMessage(FORUM_CHAT_ID, plain, opts)
      process.stderr.write(`[out] sent topic ${topicId} ${plain.length}c (plain)\n`)
    } catch (e) {
      process.stderr.write(`[out] send FAILED topic ${topicId}: ${e}\n`)
    }
  }
}
// Render Claude's questions as option buttons in the topic; return the selection.
type AskBtn = {
  multi: boolean
  selected: Set<number>
  options: { label: string; description?: string }[]
  messageId: number
  resolve: (labels: string | string[]) => void
}
const askBtns = new Map<string, AskBtn>() // token → button state
const askFreeText = new Map<string, (t: string) => void>() // topicId → free-text resolver
const FREE_TEXT = Symbol('free-text')

function askKeyboard(token: string, options: { label: string }[], multi: boolean, selected: Set<number>): InlineKeyboard {
  const kb = new InlineKeyboard()
  options.forEach((o, i) => {
    const mark = multi && selected.has(i) ? '✓ ' : ''
    kb.text(`${mark}${o.label}`.slice(0, 60), `qa:${token}:${i}`).row()
  })
  if (multi) kb.text('✅ Done', `qa:${token}:done`)
  return kb
}

function askSingle(topicId: string, q: any): Promise<string | string[]> {
  const token = permToken()
  const multi = !!q.multiSelect
  const selected = new Set<number>()
  const options = (q.options || []) as { label: string; description?: string }[]
  const body =
    `❓ ${q.header ? q.header + ': ' : ''}${q.question}\n\n` +
    options.map((o, i) => `${i + 1}. ${o.label}${o.description ? ' — ' + o.description : ''}`).join('\n') +
    `\n\n(tap a choice${multi ? '; ✅ Done when finished' : ''}, or just type your own reply)`
  return bot.api
    .sendMessage(FORUM_CHAT_ID, body, { message_thread_id: Number(topicId), reply_markup: askKeyboard(token, options, multi, selected) })
    .then(sent => new Promise<string | string[]>(resolve => {
      askBtns.set(token, { multi, selected, options, messageId: sent.message_id, resolve })
    }))
}

async function askQuestions(topicId: string, input: Record<string, unknown>): Promise<PermissionResult> {
  const questions = (input.questions as any[]) || []
  const answers: Record<string, string | string[]> = {}
  let freeText: string | undefined
  const ft = new Promise<never>((_, reject) => {
    askFreeText.set(topicId, t => { freeText = t; reject(FREE_TEXT) })
  })
  try {
    for (const q of questions) {
      answers[q.question] = (await Promise.race([askSingle(topicId, q), ft])) as string | string[]
    }
  } catch (e) {
    if (e !== FREE_TEXT) throw e
  } finally {
    askFreeText.delete(topicId)
  }
  if (freeText !== undefined) return { behavior: 'allow', updatedInput: { questions, answers: {}, response: freeText } }
  return { behavior: 'allow', updatedInput: { questions, answers } }
}

// ── Approval prompt (Allow/Deny button) ─────────────────────────────────────
// promptText may contain Telegram-HTML (e.g. <code>…</code> around a command).
// Send as HTML; if the parser rejects it, retry as plain text so an approval
// prompt is NEVER dropped (dropping it would deny a legitimate tool).
async function askApprove(topicId: string, promptText: string): Promise<PermissionResult> {
  const token = permToken()
  const kb = new InlineKeyboard().text('✅ Allow', `p:${token}:a`).text('❌ Deny', `p:${token}:d`)
  const base = { message_thread_id: Number(topicId), reply_markup: kb }
  let messageId: number | undefined
  try {
    const sent = await bot.api.sendMessage(FORUM_CHAT_ID, promptText, { ...base, parse_mode: 'HTML' })
    messageId = sent.message_id
  } catch {
    try {
      const sent = await bot.api.sendMessage(FORUM_CHAT_ID, htmlToPlain(promptText), base)
      messageId = sent.message_id
    } catch (e) {
      process.stderr.write(`approval prompt send failed: ${e}\n`)
      return { behavior: 'deny', message: 'could not deliver approval prompt' }
    }
  }
  return new Promise<PermissionResult>(resolve => pending.set(token, { resolve, topicId, messageId }))
}

// ── Permission handler factory (per topic) ──────────────────────────────────
function makeCanUseTool(topicId: string) {
  return async (
    toolName: string,
    input: Record<string, unknown>,
    opts: { displayName?: string; description?: string; toolUseID: string },
  ): Promise<PermissionResult> => {
    // Clarifying questions: ALWAYS render real options (even in auto mode — a
    // question needs an answer; auto-allowing it would return no answer).
    if (toolName === 'AskUserQuestion') return askQuestions(topicId, input)

    if (AUTO_ALLOW.has(toolName)) return { behavior: 'allow', updatedInput: input }

    // Auto mode: this topic auto-approves everything else (no Allow/Deny buttons).
    if (registry[topicId]?.auto) {
      process.stderr.write(`[auto] topic ${topicId} auto-allow ${toolName}\n`)
      return { behavior: 'allow', updatedInput: input }
    }

    // Plan mode: show the full plan, then approve/reject.
    if (toolName === 'ExitPlanMode') {
      const plan = typeof input.plan === 'string' ? (input.plan as string) : JSON.stringify(input.plan ?? input)
      await sayTopic(topicId, `📋 Proposed plan:\n\n${plan}`)
      return askApprove(topicId, '🔐 Approve this plan and proceed?')
    }

    const label = htmlEsc(opts.displayName || toolName)
    const desc = opts.description
    const detail = desc
      ? `\n${htmlEsc(desc.length > 800 ? desc.slice(0, 800) + '…' : desc)}`
      : summarizeInput(toolName, input)
    return askApprove(topicId, `🔐 ${label}${detail}`)
  }
}

// Returns a Telegram-HTML snippet (the command/path/args in a <code> block).
function summarizeInput(tool: string, input: Record<string, unknown>): string {
  if (tool === 'Bash' && typeof input.command === 'string') return `\n<code>${htmlEsc(String(input.command).slice(0, 300))}</code>`
  if ((tool === 'Write' || tool === 'Edit') && typeof input.file_path === 'string') return `\n<code>${htmlEsc(input.file_path)}</code>`
  const s = JSON.stringify(input)
  return `\n<code>${htmlEsc(s.length > 200 ? s.slice(0, 200) + '…' : s)}</code>`
}

// ── Rate-limit auto-resume ──────────────────────────────────────────────────
// When a turn is cut off by a hard rate limit (status 'rejected'), schedule an
// automatic "continue" nudge for when the window resets — the user shouldn't
// have to come back and ask "and now?". The timer is cancelled when the user
// messages the topic themselves (they've taken over, e.g. switched model).
const resumeTimers = new Map<string, ReturnType<typeof setTimeout>>()
function cancelRateLimitResume(topicId: string): void {
  const t = resumeTimers.get(topicId)
  if (t) {
    clearTimeout(t)
    resumeTimers.delete(topicId)
  }
}
// Returns the local HH:MM the nudge is scheduled for (for the user message),
// or undefined if no usable resetsAt was provided.
function scheduleRateLimitResume(topicId: string, resetsAt?: number): string | undefined {
  if (!resetsAt) return undefined
  const at = resetsAt > 1e12 ? resetsAt : resetsAt * 1000 // epoch seconds or ms
  const delay = at - Date.now() + 60_000 // small buffer past the reset
  if (delay <= 0 || delay > 12 * 3600_000) return undefined
  cancelRateLimitResume(topicId)
  resumeTimers.set(
    topicId,
    setTimeout(() => {
      resumeTimers.delete(topicId)
      if (!registry[topicId]) return // topic deleted in the meantime
      void sayTopic(topicId, '▶️ Rate limit reset — resuming automatically.')
      void sendToTopic(
        topicId,
        'The rate limit that interrupted you has reset. Continue with the task you were working on. ' +
          'If you were waiting on a background task or command, check its result now (the completion notification may have been lost) and proceed.',
      )
    }, delay),
  )
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

// ── Stream pump: forward a session's output into its topic ───────────────────
async function pump(l: Live): Promise<void> {
  l.pumping = true
  let rateLimited = false
  try {
    for await (const msg of l.session.stream() as AsyncGenerator<SDKMessage>) {
      // Capture sessionId only once a turn has produced output (assistant/result)
      // — that guarantees a transcript exists on disk. Capturing from the bare
      // init message saved an id for sessions closed before their first turn
      // (e.g. /new then immediately "use opus"), leaving a dead id that errors on
      // every later resume. (Reading session.sessionId directly throws pre-init.)
      const sid = (msg.type === 'assistant' || msg.type === 'result')
        ? ((msg as any).session_id as string | undefined)
        : undefined
      if (sid) {
        const rb = registry[l.topicId]
        if (rb && !rb.sessionId) {
          rb.sessionId = sid
          saveRegistry()
          process.stderr.write(`topic ${l.topicId}: captured sessionId ${sid.slice(0, 8)} (context now persists)\n`)
          // Surface the resumable id so it can be continued on the laptop.
          await sayTopic(l.topicId, `🆔 Session id: ${sid}\nResume on laptop:\ncd ${l.cwd} && claude --resume ${sid}`)
        }
      }
      if (msg.type === 'rate_limit_event') {
        // Fires on ANY rate-limit-info change — status 'allowed' and
        // 'allowed_warning' included. Only a real rejection should alert the
        // user; anything else was pure noise ("Rate limit hit" while nothing
        // was blocked).
        const info = (msg as any).rate_limit_info as { status?: string; resetsAt?: number } | undefined
        process.stderr.write(`[pump] topic ${l.topicId} rate_limit_event status=${info?.status} resetsAt=${info?.resetsAt}\n`)
        if (info?.status === 'rejected' && !rateLimited) {
          rateLimited = true
          const until = scheduleRateLimitResume(l.topicId, info.resetsAt)
          await send(
            l.topicId,
            until
              ? `⏳ Rate limit hit on this model — resets at ${until}. I'll continue automatically then, or switch to a lighter model (e.g. Sonnet) via ⚙️ Controls to keep going now.`
              : '⏳ Rate limit hit on this model. Wait a moment and send your message again, or switch to a lighter model (e.g. Sonnet) via ⚙️ Controls.',
            new InlineKeyboard().text('⚙️ Controls', 'm:ctl'),
          )
        }
      }
      if (msg.type === 'assistant') {
        const text = (msg.message.content as any[])
          .filter(b => b?.type === 'text')
          .map(b => b.text)
          .join('')
          .trim()
        if (text) await sayTopic(l.topicId, text)
      } else if (msg.type === 'result') {
        l.lastActive = Date.now()
        await flushOutbox(l.topicId) // deliver anything Claude saved this turn
        // Skip the generic notice if we already showed the friendlier rate-limit one.
        if (!rateLimited && ((msg as any).subtype !== 'success' || (msg as any).is_error)) {
          // Offer one-tap controls so a model/auth error is recoverable (switch model).
          await send(l.topicId, `⚠️ turn ended: ${(msg as any).subtype}. Tap ⚙️ to switch model or adjust this session.`, new InlineKeyboard().text('⚙️ Controls', 'm:ctl'))
        }
        // Reset per turn — a stale true would suppress every later error notice
        // for the lifetime of this session (turns after the first rate limit
        // used to fail in complete silence).
        rateLimited = false
      } else if (msg.type === 'system' && (msg as any).subtype === 'task_notification') {
        // A background task (e.g. a long build/test run) finished. The SDK
        // re-invokes the model with the result, but if that continuation is
        // rate-limited or the session died, the user would never hear about
        // it — so always surface the completion itself.
        const t = msg as any
        const icon = t.status === 'completed' ? '✅' : t.status === 'failed' ? '❌' : '⏹'
        await sayTopic(l.topicId, `${icon} Background task ${t.status}${t.summary ? `: ${t.summary}` : ''}`)
      }
    }
  } catch (e) {
    await sayTopic(l.topicId, `⚠️ session error: ${e}`)
  } finally {
    await flushOutbox(l.topicId) // deliver files even if the turn ended abnormally
    l.pumping = false
    // The stream is done (closed, crashed, or completed). ALWAYS close the SDK
    // session so its `claude` child process is terminated — otherwise every resume
    // spawns a fresh process while the old one lingers, leaking dozens of stray
    // child processes over a session's lifetime. Resume works from the on-disk
    // transcript, so killing the old process costs nothing.
    try {
      l.session.close()
    } catch {}
    if (live.get(l.topicId) === l) {
      live.delete(l.topicId)
      process.stderr.write(`topic ${l.topicId}: session stream ended, closed + evicted (resumes on next message)\n`)
    }
  }
}

// ── Session lifecycle ────────────────────────────────────────────────────────
// Child sessions must NOT see the bot token — a prompt-injected session (via
// fetched web/file content) could otherwise read it from env and exfiltrate it.
const CHILD_ENV: Record<string, string | undefined> = (() => {
  const e = { ...process.env }
  delete e.TELEGRAM_BOT_TOKEN
  return e
})()

// ── Outbox: files Claude saves here are delivered to the topic ───────────────
// Each session gets TELEPATH_OUTBOX in its env; anything dropped there is sent
// to the Telegram topic (photos as photos, else as documents). We also pick up
// image paths Claude names in its text.
const OUTBOX_BASE = join(STATE_DIR, 'outbox')
function outboxDir(topicId: string): string {
  return join(OUTBOX_BASE, topicId)
}
const IMG_RE = /\.(png|jpe?g|gif|webp|bmp)$/i

// Remove a topic's outbox folder (used by the full-wipe button).
function removeOutbox(topicId: string): void {
  try {
    rmSync(outboxDir(topicId), { recursive: true, force: true })
  } catch {}
}

// Delete a session's transcript from ~/.claude/projects (makes it unresumable).
// Files are named <sessionId>.jsonl under a per-project subfolder.
function deleteTranscript(sessionId: string): void {
  const base = join(homedir(), '.claude', 'projects')
  let projects: string[]
  try {
    projects = readdirSync(base)
  } catch {
    return
  }
  for (const p of projects) {
    const f = join(base, p, `${sessionId}.jsonl`)
    try {
      if (existsSync(f)) {
        rmSync(f, { force: true })
        process.stderr.write(`[wipe] removed transcript ${f}\n`)
      }
    } catch {}
  }
}

// Returns true only if Telegram accepted the file — so the caller knows whether
// it's safe to delete.
async function sendFileToTopic(topicId: string, filePath: string): Promise<boolean> {
  const opts = { message_thread_id: Number(topicId), caption: basename(filePath) }
  try {
    if (IMG_RE.test(filePath)) await bot.api.sendPhoto(FORUM_CHAT_ID, new InputFile(filePath), opts)
    else await bot.api.sendDocument(FORUM_CHAT_ID, new InputFile(filePath), opts)
    process.stderr.write(`[media] sent ${filePath} → topic ${topicId}\n`)
    return true
  } catch (e) {
    process.stderr.write(`[media] send failed ${filePath}: ${e}\n`)
    return false
  }
}

// Deliver everything in this topic's outbox. Delete each file only after a
// successful send — a failed send is left in place to retry next flush, and
// nothing is archived (that used to grow the outbox unboundedly).
async function flushOutbox(topicId: string): Promise<void> {
  const dir = outboxDir(topicId)
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  for (const name of names) {
    if (name === 'sent') continue // legacy archive folder from older versions
    const p = join(dir, name)
    try {
      if (!statSync(p).isFile()) continue
    } catch {
      continue
    }
    if (await sendFileToTopic(topicId, p)) {
      try {
        rmSync(p, { force: true })
      } catch (e) {
        // Sent but couldn't delete — archive it so it isn't re-delivered next flush.
        process.stderr.write(`[media] delete failed ${p}: ${e}\n`)
        try {
          const sentDir = join(dir, 'sent')
          mkdirSync(sentDir, { recursive: true })
          renameSync(p, join(sentDir, name))
        } catch {}
      }
    }
  }
}

// The file-delivery contract, stated once to each session. Delivered two ways:
// via the SessionStart hook (proper, but not reliably plumbed in the unstable
// v2 API) AND prepended to the first prompt of a session (guaranteed to reach
// the model). Not text-scraping — it's the documented I/O contract.
const primed = new Set<string>() // topics already told about the outbox this process
function outboxContract(topicId: string): string {
  return (
    `You are operated remotely over Telegram; the user cannot see your filesystem. ` +
    `To show the user an image or file (screenshot, chart, diagram, PDF, export), copy or save it into this directory:\n` +
    `${outboxDir(topicId)}\n` +
    `Anything placed there is delivered to the user in this chat automatically — images as photos, other files as documents. ` +
    `When the user asks to see something visual, deliver it this way; don't only describe it.`
  )
}

// SessionStart hook: the proper injected-context channel (kept as belt-and-
// suspenders; priming the first prompt is the guaranteed path).
function makeHooks(topicId: string) {
  return {
    SessionStart: [
      {
        hooks: [
          async () => ({
            hookSpecificOutput: {
              hookEventName: 'SessionStart' as const,
              additionalContext: outboxContract(topicId),
            },
          }),
        ],
      },
    ],
  }
}

function sessionOptions(cwd: string, model: string, topicId: string, effort?: Effort) {
  const outbox = outboxDir(topicId)
  try {
    mkdirSync(outbox, { recursive: true })
  } catch {}
  // Drop any level inherited from the daemon's own shell first: "default" must
  // mean Claude Code's own default (settings.json effortLevel or built-in), and
  // Haiku would otherwise inherit a level it rejects.
  const env: Record<string, string | undefined> = { ...CHILD_ENV, TELEPATH_OUTBOX: outbox }
  delete env.CLAUDE_CODE_EFFORT_LEVEL
  if (effort) env.CLAUDE_CODE_EFFORT_LEVEL = effort
  return {
    model,
    cwd,
    env,
    pathToClaudeCodeExecutable: CLAUDE_BIN,
    settingSources: SETTING_SOURCES,
    permissionMode: 'default' as const,
    allowedTools: [...AUTO_ALLOW],
    canUseTool: makeCanUseTool(topicId),
    hooks: makeHooks(topicId),
  }
}

function enforceCap(): void {
  while (live.size >= MAX_LIVE_SESSIONS) {
    let oldest: Live | undefined
    for (const l of live.values()) if (!oldest || l.lastActive < oldest.lastActive) oldest = l
    if (!oldest) break
    // Let the user know their least-recent session was paused to free a slot —
    // context is kept and it resumes on the next message (fire-and-forget).
    void send(oldest.topicId, `💤 Paused to free a slot (max ${MAX_LIVE_SESSIONS} live sessions). Send a message here to resume — your context is kept.`)
    closeLive(oldest.topicId, 'evicted (session cap)')
  }
}

function closeLive(topicId: string, why?: string): void {
  const l = live.get(topicId)
  if (!l) return
  try {
    l.session.close()
  } catch {}
  live.delete(topicId)
  if (why) process.stderr.write(`closed topic ${topicId}: ${why}\n`)
}

async function ensureLive(topicId: string): Promise<Live | undefined> {
  const existing = live.get(topicId)
  if (existing) return existing
  const b = registry[topicId]
  if (!b) return undefined // no binding — needs /new
  enforceCap()
  const opts = sessionOptions(b.cwd, b.model, topicId, effortFor(b))
  const session = b.sessionId
    ? unstable_v2_resumeSession(b.sessionId, opts)
    : unstable_v2_createSession(opts)
  const l: Live = { session, topicId, model: b.model, cwd: b.cwd, lastActive: Date.now(), pumping: false }
  live.set(topicId, l)
  void pump(l)
  return l
}

async function sendToTopic(topicId: string, text: string): Promise<void> {
  // Any message into the topic supersedes a pending rate-limit auto-resume
  // (the user took over — e.g. switched model and re-asked).
  cancelRateLimitResume(topicId)
  let l = await ensureLive(topicId)
  if (!l) {
    await sayTopic(topicId, 'No session bound to this topic. Use /new (or /attach) first.')
    return
  }
  l.lastActive = Date.now()
  // Prepend the outbox contract once per topic so the model knows how to deliver
  // images/files to the user (guaranteed channel; the hook is best-effort).
  let payload = text
  if (!primed.has(topicId)) {
    primed.add(topicId)
    payload = `<telepath>\n${outboxContract(topicId)}\n</telepath>\n\n${text}`
  }
  await bot.api.sendChatAction(FORUM_CHAT_ID, 'typing', { message_thread_id: Number(topicId) }).catch(() => {})
  try {
    await l.session.send(payload)
  } catch (e) {
    // Stale/dead handle slipped through — evict and resume once.
    process.stderr.write(`topic ${topicId}: send failed (${e}); recreating session\n`)
    live.delete(topicId)
    const l2 = await ensureLive(topicId)
    if (!l2) return
    l = l2
    await l.session.send(payload)
  }
  // capture sessionId once initialized (for resume after restart/eviction)
  try {
    const b = registry[topicId]
    if (b && !b.sessionId) {
      b.sessionId = l.session.sessionId
      saveRegistry()
    }
  } catch {}
}

// ── Idle eviction ─────────────────────────────────────────────────────────────
setInterval(() => {
  const cutoff = Date.now() - IDLE_MINUTES * 60_000
  for (const l of [...live.values()]) {
    if (!l.pumping && l.lastActive < cutoff) closeLive(l.topicId, 'idle')
  }
}, 60_000).unref()

// ── Access gate ───────────────────────────────────────────────────────────────
function allowed(ctx: Context): boolean {
  return (
    String(ctx.from?.id) === ALLOWED_USER_ID &&
    String(ctx.chat?.id) === FORUM_CHAT_ID
  )
}

// ── Commands ────────────────────────────────────────────────────────────────
function expandHome(p: string): string {
  return p.startsWith('~') ? join(homedir(), p.slice(1)) : p
}

// `/new <name…>` — the whole arg is the topic name. Optional `cwd=<path>` token
// (anywhere) sets the working dir; it's validated and ignored if it's not a real dir.
function parseNew(args: string, notify: (s: string) => void): { name: string; cwd: string; auto: boolean } {
  const fallback = defaultCwd()
  let cwd = fallback
  let auto = false
  const kept: string[] = []
  for (const t of args.trim().split(/\s+/).filter(Boolean)) {
    if (t.startsWith('cwd=')) {
      const cand = expandHome(t.slice(4))
      if (existsSync(cand) && statSync(cand).isDirectory()) cwd = cand
      else notify(`(ignoring cwd="${cand}" — not a directory; using ${fallback})`)
    } else if (t.toLowerCase() === 'auto') {
      auto = true
    } else {
      kept.push(t)
    }
  }
  return { name: kept.join(' ') || `session-${Date.now().toString(36)}`, cwd, auto }
}

async function cmdNew(args: string, fromTopic: string | undefined): Promise<void> {
  const notes: string[] = []
  const { name, cwd, auto } = parseNew(args, s => notes.push(s))
  for (const n of notes) await sayTopic(fromTopic, n)
  let topicId: string
  try {
    const topic = await bot.api.createForumTopic(FORUM_CHAT_ID, name)
    topicId = String(topic.message_thread_id)
  } catch (e) {
    await sayTopic(fromTopic, `Couldn't create topic (is the bot admin with Manage Topics?): ${e}`)
    return
  }
  const model = prefs.defaultModel
  registry[topicId] = { cwd, model, effort: prefs.defaultEffort, title: name, lastActive: Date.now(), auto }
  saveRegistry()
  await ensureLive(topicId)
  await postPinnedControls(topicId)
}

async function cmdAuto(args: string, topicId: string | undefined): Promise<void> {
  if (!topicId) return void sayTopic(undefined, '/auto must be used inside a session topic.')
  const b = registry[topicId]
  if (!b) return void sayTopic(topicId, 'No session bound to this topic yet — send a message first, or /new.')
  const arg = args.trim().toLowerCase()
  b.auto = arg === 'on' ? true : arg === 'off' ? false : !b.auto
  saveRegistry() // takes effect immediately — canUseTool reads the flag live
  await sayTopic(topicId, b.auto
    ? '⚡ Auto mode ON — tools run without asking (questions still prompt). /auto off to disable.'
    : '🔐 Auto mode OFF — risky tools (Bash/Write/Edit/Web) will ask for Allow/Deny.')
}

async function cmdAttach(args: string, fromTopic: string | undefined): Promise<string | undefined> {
  // /attach <short-id> [topicName]
  const parts = args.trim().split(/\s+/)
  const shortId = parts[0]
  if (!shortId) {
    await sayTopic(fromTopic, 'Usage: /attach <short-id> [topic name]')
    return
  }
  let match
  try {
    const sessions = await listSessions()
    match = sessions.find(s => s.sessionId.startsWith(shortId))
  } catch (e) {
    await sayTopic(fromTopic, `listSessions failed: ${e}`)
    return
  }
  if (!match) {
    await sayTopic(fromTopic, `No session starting with \`${shortId}\`.`)
    return
  }
  const name = parts.slice(1).join(' ') || (match.summary || shortId).slice(0, 40)
  let topicId: string
  try {
    const topic = await bot.api.createForumTopic(FORUM_CHAT_ID, name)
    topicId = String(topic.message_thread_id)
  } catch (e) {
    await sayTopic(fromTopic, `Couldn't create topic: ${e}`)
    return
  }
  registry[topicId] = {
    sessionId: match.sessionId,
    cwd: (match as any).cwd || DEFAULT_CWD,
    model: prefs.defaultModel,
    effort: prefs.defaultEffort,
    title: name,
    lastActive: Date.now(),
  }
  saveRegistry()
  await postPinnedControls(topicId)
  return topicId
}

// `use fable high` / `use opus` — model switch with an optional effort level.
async function setModel(topicId: string, which: keyof typeof MODELS, effort?: Effort): Promise<void> {
  const b = registry[topicId]
  if (!b) {
    await sayTopic(topicId, 'No session bound here.')
    return
  }
  b.model = MODELS[which]
  if (effort) b.effort = effort
  saveRegistry()
  closeLive(topicId, 'model switch') // next message resumes with new model
  await sayTopic(topicId, `Model set to ${b.model}${effortFor(b) ? ` · effort ${effortFor(b)}` : ''}. (applies on next message)`)
}

// `effort max` / `effort default` — change only the reasoning depth of this topic.
async function setEffort(topicId: string, effort: Effort | undefined): Promise<void> {
  const b = registry[topicId]
  if (!b) {
    await sayTopic(topicId, 'No session bound here.')
    return
  }
  if (!supportsEffort(b.model)) {
    await sayTopic(topicId, `${modelLabel(b.model)} has no effort levels — switch model first.`)
    return
  }
  b.effort = effort
  saveRegistry()
  closeLive(topicId, 'effort switch') // the level travels in the child env, so restart the process
  await sayTopic(topicId, `Effort set to ${effort ?? 'default'}. (applies on next message)`)
}

// ── Button UX (dummy-proof menus) ───────────────────────────────────────────
// Everything you can do with /commands is also reachable by tapping buttons.
// Friendly labels per model.
const MODEL_LABEL: Record<string, string> = {
  [HAIKU_MODEL]: '🐇 Haiku',
  [SONNET_MODEL]: '⚡ Sonnet',
  [OPUS_MODEL]: '🧠 Opus',
  [FABLE_MODEL]: '✨ Fable',
}
function modelLabel(m: string): string {
  return MODEL_LABEL[m] || m
}
function modelKey(m: string): string | undefined {
  return Object.keys(MODELS).find(k => MODELS[k] === m)
}
// Own-property check: callback data and typed text are user input, and a plain
// `in` would accept prototype names like "constructor".
function isModelKey(k: string): boolean {
  return Object.hasOwn(MODELS, k) && Object.hasOwn(MODEL_MENU, k)
}
function supportsEffort(model: string): boolean {
  const k = modelKey(model)
  return !!k && EFFORT_MODELS.has(k)
}
// The effort a binding actually runs with: its own level, only where the model
// accepts one (a topic switched to Haiku keeps its level for when it switches back).
function effortFor(b: Binding): Effort | undefined {
  return supportsEffort(b.model) ? b.effort : undefined
}
const EFFORT_MENU: Record<Effort, { short: string; long: string }> = {
  low: { short: 'low', long: '🎚 low — quick & cheap' },
  medium: { short: 'med', long: '🎚 medium — balanced' },
  high: { short: 'high', long: '🎚 high — deep reasoning' },
  xhigh: { short: 'xhigh', long: '🎚 xhigh — deeper, best for hard coding' },
  max: { short: 'max', long: '🎚 max — everything it has' },
}

// Short / long button labels per model key. Version numbers stay out of the
// labels because the id behind a key comes from .env (see modelLine()).
const MODEL_MENU: Record<string, { short: string; long: string }> = {
  haiku: { short: '🐇 Haiku', long: '🐇 Haiku — cheapest & fastest, no effort levels' },
  sonnet: { short: '⚡ Sonnet', long: '⚡ Sonnet — fast & cheap' },
  opus: { short: '🧠 Opus', long: '🧠 Opus — strong all-rounder (~2.5× Sonnet)' },
  fable: { short: '✨ Fable', long: '✨ Fable — frontier, premium (~2× Opus)' },
}
// Which id each enabled key resolves to, for the wizard / settings body text.
function modelLines(): string {
  return ENABLED_MODELS.map(k => `${MODEL_MENU[k].short} → ${MODELS[k]}`).join('\n')
}
// Only offer models you actually have access to — set ENABLED_MODELS in .env
// (e.g. ENABLED_MODELS=haiku,sonnet,opus,fable) to what your auth can reach;
// a model your plan lacks fails on the first message. Order here = menu order.
const ENABLED_MODELS_RAW = (process.env.ENABLED_MODELS || 'sonnet,opus')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(isModelKey)
// Never let the menus end up with zero models (empty/garbage ENABLED_MODELS).
const ENABLED_MODELS = ENABLED_MODELS_RAW.length ? ENABLED_MODELS_RAW : ['sonnet']
// Guard the default model: if it points at a disabled model, fall back.
if (!ENABLED_MODELS.some(k => MODELS[k] === prefs.defaultModel)) {
  prefs.defaultModel = MODELS[ENABLED_MODELS[0]] || SONNET_MODEL
}
// Migrate any existing session bindings off a now-disabled model (e.g. Fable),
// so a previously-created topic doesn't keep failing on an inaccessible model.
let migrated = false
for (const b of Object.values(registry)) {
  if (!ENABLED_MODELS.some(k => MODELS[k] === b.model)) {
    b.model = prefs.defaultModel
    migrated = true
  }
}
if (migrated) saveRegistry()

// Candidate working dirs for the folder picker: the default folder first, then
// EVERY repo/project folder under REPOS_DIR — git repos sort first,
// then other project dirs — then Home. Pagination handles long lists.
function listRepoFolders(): string[] {
  const def = defaultCwd()
  const entries: { path: string; mtime: number; git: boolean }[] = []
  try {
    for (const name of readdirSync(REPOS_DIR)) {
      if (name.startsWith('.')) continue
      const p = join(REPOS_DIR, name)
      try {
        const st = statSync(p)
        if (!st.isDirectory()) continue
        entries.push({ path: p, mtime: st.mtimeMs, git: existsSync(join(p, '.git')) })
      } catch {}
    }
  } catch {}
  // Most-recently-modified first; git repos still rank above loose dirs.
  entries.sort((a, b) => Number(b.git) - Number(a.git) || b.mtime - a.mtime)
  return [...new Set([def, ...entries.map(e => e.path), homedir()])]
}

// New-session wizard state (single user → keyed by user id).
type Wizard = { step: 'folder' | 'model' | 'effort' | 'auto'; folders: string[]; cwd?: string; model?: string; effort?: Effort; bindTopic?: string }
const wizard = new Map<string, Wizard>()

function mainMenuKb(): InlineKeyboard {
  return new InlineKeyboard()
    .text('🆕 New session', 'm:new').text('⚡ Quick new', 'm:quick').row()
    .text('📋 My sessions', 'm:list').text('▶️ Resume last', 'm:resume').row()
    .text('⚙️ Settings', 'm:settings').text('❓ Help', 'm:help')
}

const backKb = () => new InlineKeyboard().text('⬅️ Back', 'm:menu')

// Deep link to a forum topic: t.me/c/<id-without-100>/<topicId>.
function topicUrl(topicId: string): string {
  return `https://t.me/c/${FORUM_CHAT_ID.replace(/^-100/, '')}/${topicId}`
}
const openLinkKb = (topicId: string) =>
  new InlineKeyboard().url('➡️ Go to topic', topicUrl(topicId)).row().text('⬅️ Back', 'm:menu')

// One-tap session in the default folder + default model (no wizard).
async function quickNew(intoTopic: string | undefined): Promise<void> {
  const cwd = defaultCwd()
  const model = prefs.defaultModel
  const name = basename(cwd)
  try {
    const topic = await bot.api.createForumTopic(FORUM_CHAT_ID, name)
    const tid = String(topic.message_thread_id)
    registry[tid] = { cwd, model, effort: prefs.defaultEffort, title: name, lastActive: Date.now(), auto: false }
    saveRegistry()
    await ensureLive(tid)
    await paint(intoTopic, `✅ Created "${name}".`, openLinkKb(tid))
    await postPinnedControls(tid)
  } catch (e) {
    await paint(intoTopic, `Couldn't create topic (is the bot admin with Manage Topics?): ${e}`, backKb())
  }
}

// Open the most recently active session.
async function resumeLast(intoTopic: string | undefined): Promise<void> {
  let sessions
  try {
    sessions = await listSessions()
  } catch (e) {
    return void paint(intoTopic, `Couldn't load sessions: ${e}`, backKb())
  }
  if (!sessions.length) return void paint(intoTopic, 'No sessions yet.', new InlineKeyboard().text('🆕 New session', 'm:new').row().text('⬅️ Back', 'm:menu'))
  const last = sessions.sort((a, b) => b.lastModified - a.lastModified)[0]
  const already = Object.values(registry).find(b => b.sessionId === last.sessionId)
  if (already) return void paint(intoTopic, `📌 Most recent "${already.title}" is already open.`, backKb())
  await paint(intoTopic, '📎 Opening the most recent session…', backKb())
  const tid = await cmdAttach(last.sessionId.slice(0, 8), intoTopic)
  await paint(intoTopic, tid ? `✅ Opened "${last.summary || last.sessionId.slice(0, 8)}".` : '⚠️ Could not open that session.', tid ? openLinkKb(tid) : backKb())
}

// Settings: default model + default folder for new/quick sessions.
function settingsKb(): InlineKeyboard {
  const kb = new InlineKeyboard()
  ENABLED_MODELS.forEach((k, i) => {
    kb.text(`${MODEL_MENU[k].short}${prefs.defaultModel === MODELS[k] ? ' ✓' : ''}`, `m:sdm:${k}`)
    if (i % 2 === 1) kb.row()
  })
  if (ENABLED_MODELS.length % 2 === 1) kb.row()
  effortRows(kb, prefs.defaultEffort, 'sde')
  return kb.text('📁 Default folder', 'm:sdf').row().text('⬅️ Back', 'm:menu')
}
// Two rows of effort buttons (low/med/high, xhigh/max/default) with ✓ on the
// active one; `ns` is the callback namespace (settings vs topic controls).
function effortRows(kb: InlineKeyboard, current: Effort | undefined, ns: string): void {
  EFFORT_LEVELS.forEach((e, i) => {
    kb.text(`🎚 ${EFFORT_MENU[e].short}${current === e ? ' ✓' : ''}`, `m:${ns}:${e}`)
    if (i === 2) kb.row()
  })
  kb.text(`↺ default${current ? '' : ' ✓'}`, `m:${ns}:auto`).row()
}
async function showSettings(intoTopic: string | undefined): Promise<void> {
  await paint(
    intoTopic,
    `⚙️ Settings — defaults for 🆕/⚡ new sessions:\nModel: ${modelLabel(prefs.defaultModel)} (${prefs.defaultModel})\nEffort: ${prefs.defaultEffort ?? 'default (Claude Code decides)'}\nFolder: ${defaultCwd()}\n\n${modelLines()}`,
    settingsKb(),
  )
}

// Default-folder picker (own callback namespace so it doesn't touch the wizard).
let defaultFolderChoices: string[] = []
async function showDefaultFolderPicker(intoTopic: string | undefined, page = 0): Promise<void> {
  defaultFolderChoices = listRepoFolders()
  const buttons = defaultFolderChoices.map((f, i) => ({ label: '📁 ' + basename(f), data: `m:sdfi:${i}` }))
  await paint(intoTopic, `📁 Pick the default folder for new sessions:${pageSuffix(buttons.length, page)}`, pagedListKb(buttons, page, 'sdfp', k => k.text('⬅️ Back', 'm:settings')))
}

async function send(topicId: string | undefined, text: string, kb?: InlineKeyboard): Promise<void> {
  const opts: Record<string, unknown> = topicId ? { message_thread_id: Number(topicId) } : {}
  if (kb) opts.reply_markup = kb
  await bot.api.sendMessage(FORUM_CHAT_ID, text, opts).catch(e => process.stderr.write(`[menu] send failed: ${e}\n`))
}

// Set for the duration of a button tap so menu screens repaint the SAME message
// (in-place) instead of spamming a new one. bot.start() processes updates
// sequentially, so a single module-level slot is race-free.
let menuCtx: Context | undefined
async function paint(topicId: string | undefined, text: string, kb?: InlineKeyboard): Promise<void> {
  if (menuCtx?.callbackQuery?.message) {
    try {
      await menuCtx.editMessageText(text, { reply_markup: kb })
      return
    } catch {
      // "message is not modified" / too old → fall through to a fresh message.
    }
  }
  await send(topicId, text, kb)
}

function pageMeta(total: number, page: number): { p: number; pages: number } {
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  return { p: Math.min(Math.max(0, page), pages - 1), pages }
}
function pageSuffix(total: number, page: number): string {
  const { p, pages } = pageMeta(total, page)
  return pages > 1 ? ` · page ${p + 1}/${pages}` : ''
}

async function showMainMenu(topicId: string | undefined): Promise<void> {
  await paint(topicId, '👋 What would you like to do?', mainMenuKb())
}

// Topic control panel — pinned to the top of each session topic.
function topicControlsKb(b: Binding): InlineKeyboard {
  const kb = new InlineKeyboard()
  for (const k of ENABLED_MODELS) kb.text(`${MODEL_MENU[k].short}${b.model === MODELS[k] ? ' ✓' : ''}`, `m:tm:${k}`)
  kb.row()
  if (supportsEffort(b.model)) effortRows(kb, b.effort, 'te')
  kb.text(b.auto ? '⚡ Auto: ON → switch to approvals' : '🔐 Approvals: ON → switch to auto', 'm:ta').row()
  kb.text('💾 Close & keep', 'm:tclose').text('🗑 Close & delete', 'm:tdelete').row()
  kb.text('🧹 Close, delete & remove all', 'm:twipe')
  return kb
}

function topicControlsText(b: Binding, note?: string): string {
  const effort = supportsEffort(b.model) ? ` · 🎚 ${b.effort ?? 'default'}` : ''
  return `⚙️ "${b.title}"\nModel: ${modelLabel(b.model)} (${b.model})${effort} · ${b.auto ? '⚡ auto (no prompts)' : '🔐 approvals on'}\ncwd ${b.cwd}\n\n💬 Just type your request below.${note ? `\n${note}` : ''}`
}

// Post the control panel as a fresh message and PIN it, so it's always one tap
// away at the top of the topic. Removes any previous pinned panel first.
async function postPinnedControls(topicId: string): Promise<void> {
  const b = registry[topicId]
  if (!b) return
  if (b.controlMsgId) {
    await bot.api.unpinChatMessage(FORUM_CHAT_ID, b.controlMsgId).catch(() => {})
    await bot.api.deleteMessage(FORUM_CHAT_ID, b.controlMsgId).catch(() => {})
  }
  try {
    const sent = await bot.api.sendMessage(FORUM_CHAT_ID, topicControlsText(b), {
      message_thread_id: Number(topicId),
      reply_markup: topicControlsKb(b),
    })
    b.controlMsgId = sent.message_id
    saveRegistry()
    // Pin non-silently: the "pinned" event forces mobile Telegram to show the
    // per-topic pin bar (a silent pin often doesn't surface it there).
    await bot.api
      .pinChatMessage(FORUM_CHAT_ID, sent.message_id)
      .catch(e => process.stderr.write(`[pin] failed topic ${topicId}: ${e}\n`))
  } catch (e) {
    process.stderr.write(`[controls] post failed topic ${topicId}: ${e}\n`)
  }
}

async function showTopicControls(topicId: string): Promise<void> {
  const b = registry[topicId]
  if (!b) return void paint(topicId, 'No session here yet.', new InlineKeyboard().text('🆕 Start a session here', 'm:newhere'))
  await postPinnedControls(topicId)
}

// Reusable paginated button list: 2 buttons per row, max 5 rows (10/page), then
// ◀️/▶️ nav. `extra` adds a trailing row (e.g. New / Back). Used everywhere a
// list of choices could grow long (sessions, folders).
const PAGE_SIZE = 10
function pagedListKb(
  buttons: { label: string; data: string }[],
  page: number,
  navPrefix: string,
  extra?: (kb: InlineKeyboard) => void,
): InlineKeyboard {
  const pages = Math.max(1, Math.ceil(buttons.length / PAGE_SIZE))
  const p = Math.min(Math.max(0, page), pages - 1)
  const slice = buttons.slice(p * PAGE_SIZE, p * PAGE_SIZE + PAGE_SIZE)
  const kb = new InlineKeyboard()
  slice.forEach((b, i) => {
    kb.text(b.label, b.data)
    if (i % 2 === 1) kb.row() // 2 per row
  })
  if (slice.length % 2 === 1) kb.row()
  if (pages > 1) {
    if (p > 0) kb.text('◀️ Prev', `m:${navPrefix}:${p - 1}`)
    if (p < pages - 1) kb.text('Next ▶️', `m:${navPrefix}:${p + 1}`)
    kb.row()
  }
  extra?.(kb)
  return kb
}

// "My sessions" as tappable buttons (📌 bound, 🟢 live). Tap one to open it.
async function showSessions(intoTopic: string | undefined, page = 0): Promise<void> {
  let sessions
  try {
    sessions = await listSessions()
  } catch (e) {
    return void paint(intoTopic, `Couldn't load sessions: ${e}`, backKb())
  }
  sessions = sessions.sort((a, b) => b.lastModified - a.lastModified)
  if (!sessions.length) {
    return void paint(intoTopic, 'No sessions yet.', new InlineKeyboard().text('🆕 New session', 'm:new').row().text('⬅️ Back', 'm:menu'))
  }
  const boundIds = new Set(Object.values(registry).map(b => b.sessionId).filter(Boolean))
  const buttons = sessions.map(s => {
    const liveMark = [...live.values()].some(l => registry[l.topicId]?.sessionId === s.sessionId) ? '🟢' : ''
    const mark = boundIds.has(s.sessionId) ? '📌' : liveMark
    const title = (s.customTitle || s.summary || s.firstPrompt || 'untitled').replace(/\s+/g, ' ').slice(0, 26)
    return { label: `${mark}${title}`.slice(0, 30), data: `m:sess:${s.sessionId.slice(0, 8)}` }
  })
  const kb = pagedListKb(buttons, page, 'spage', k => {
    k.text('🆕 New', 'm:new').text('⬅️ Back', 'm:menu')
  })
  await paint(intoTopic, `📋 Your sessions (${sessions.length})${pageSuffix(buttons.length, page)} — tap one to open:`, kb)
}

// Wizard step 1: pick a folder (paginated, same 2-col layout).
async function startWizard(uid: string, bindTopic: string | undefined, intoTopic: string | undefined): Promise<void> {
  const folders = listRepoFolders()
  wizard.set(uid, { step: 'folder', folders, bindTopic })
  await renderFolderPage(uid, intoTopic, 0)
}

async function renderFolderPage(uid: string, intoTopic: string | undefined, page: number): Promise<void> {
  const w = wizard.get(uid)
  if (!w) return void paint(intoTopic, 'Expired — tap 🆕 again.', mainMenuKb())
  const buttons = w.folders.map((f, i) => ({ label: '📁 ' + basename(f), data: `m:nf:${i}` }))
  const kb = pagedListKb(buttons, page, 'fpage', k => k.text('⬅️ Back', 'm:menu').text('✖️ Cancel', 'm:cancel'))
  await paint(intoTopic, `📁 Step 1/4 — pick a folder (from ${REPOS_DIR}):${pageSuffix(buttons.length, page)}`, kb)
}

// Wizard step 2: pick a model.
async function wizardModelStep(uid: string, intoTopic: string | undefined): Promise<void> {
  const kb = new InlineKeyboard()
  for (const k of ENABLED_MODELS) kb.text(MODEL_MENU[k].long, `m:nm:${k}`).row()
  kb.text('⬅️ Back', 'm:new').text('✖️ Cancel', 'm:cancel')
  await paint(intoTopic, `🤖 Step 2/4 — pick a model:\n${modelLines()}`, kb)
}

// Wizard step 3: pick an effort level (skipped for models without one).
async function wizardEffortStep(uid: string, intoTopic: string | undefined): Promise<void> {
  const kb = new InlineKeyboard()
  for (const e of EFFORT_LEVELS) kb.text(EFFORT_MENU[e].long, `m:ne:${e}`).row()
  kb.text(`↺ default${prefs.defaultEffort ? ` (settings: ${prefs.defaultEffort})` : ' (Claude Code decides)'}`, 'm:ne:auto').row()
  kb.text('⬅️ Back', 'm:nback').text('✖️ Cancel', 'm:cancel')
  await paint(intoTopic, '🎚 Step 3/4 — how hard should it think?', kb)
}

// Wizard step 4: approvals vs auto.
async function wizardAutoStep(uid: string, intoTopic: string | undefined): Promise<void> {
  const kb = new InlineKeyboard()
    .text('🔐 Ask me before running tools (recommended)', 'm:na:0').row()
    .text('⚡ Auto-run everything (no prompts)', 'm:na:1').row()
    .text('✖️ Cancel', 'm:cancel')
  await paint(intoTopic, '🔐 Step 4/4 — how should tools run?', kb)
}

// Wizard finish: create or bind a session, then drop the user into its topic.
async function finishWizard(uid: string, auto: boolean): Promise<void> {
  const w = wizard.get(uid)
  if (!w || !w.cwd) return
  wizard.delete(uid)
  const name = basename(w.cwd)
  const model = w.model || prefs.defaultModel
  // "↺ default" in the wizard leaves w.effort unset → the Settings default.
  const effort = w.effort ?? prefs.defaultEffort
  let topicId = w.bindTopic
  if (!topicId) {
    try {
      const topic = await bot.api.createForumTopic(FORUM_CHAT_ID, name)
      topicId = String(topic.message_thread_id)
    } catch (e) {
      await send(undefined, `Couldn't create topic (is the bot admin with Manage Topics?): ${e}`)
      return
    }
  }
  registry[topicId] = { cwd: w.cwd, model, effort, title: name, lastActive: Date.now(), auto }
  saveRegistry()
  await ensureLive(topicId)
  // If this was the "start here" flow, the wizard message lives in the same
  // topic as the welcome — repaint it to a confirmation; otherwise repaint the
  // General wizard message and post the welcome into the brand-new topic.
  if (w.bindTopic) {
    // Wizard ran inside this topic — drop its now-stale message so the only
    // thing left is the single pinned controls panel.
    const wizMsg = menuCtx?.callbackQuery?.message?.message_id
    if (wizMsg) await bot.api.deleteMessage(FORUM_CHAT_ID, wizMsg).catch(() => {})
  } else {
    // Confirmation stays in the General menu; the new topic gets only the panel.
    await paint(undefined, `✅ Created "${name}".`, openLinkKb(topicId))
  }
  await postPinnedControls(topicId)
}

// Route all m:* button taps.
async function handleMenu(ctx: Context, data: string): Promise<void> {
  const uid = String(ctx.from?.id)
  const topicId = ctx.callbackQuery?.message?.message_thread_id ? String(ctx.callbackQuery.message.message_thread_id) : undefined
  const ack = (t?: string) => ctx.answerCallbackQuery(t ? { text: t } : undefined).catch(() => {})

  if (data === 'm:menu') { await ack(); return showMainMenu(topicId) }
  if (data === 'm:noop') return void ack()
  if (data === 'm:new') { await ack(); return startWizard(uid, undefined, topicId) }
  if (data === 'm:newhere') { await ack(); return startWizard(uid, topicId, topicId) }
  if (data === 'm:quick') { await ack('Creating…'); return quickNew(topicId) }
  if (data === 'm:list') { await ack(); return showSessions(topicId, 0) }
  if (data === 'm:resume') { await ack('Resuming…'); return resumeLast(topicId) }
  if (data === 'm:settings') { await ack(); return showSettings(topicId) }
  if (data === 'm:help') { await ack(); return void send(topicId, HELP, backKb()) }
  if (data === 'm:cancel') { wizard.delete(uid); await ack('Cancelled'); return showMainMenu(topicId) }
  if (data === 'm:ctl') { await ack(); return topicId ? showTopicControls(topicId) : showMainMenu(topicId) }

  // Settings: default model / default effort / default folder.
  const sdm = /^m:sdm:(\w+)$/.exec(data)
  if (sdm && isModelKey(sdm[1])) { prefs.defaultModel = MODELS[sdm[1]]; savePrefs(); await ack(`Default: ${sdm[1]}`); return showSettings(topicId) }
  const sde = /^m:sde:(\w+)$/.exec(data)
  if (sde && (sde[1] === 'auto' || parseEffort(sde[1]))) {
    prefs.defaultEffort = parseEffort(sde[1])
    savePrefs()
    await ack(`Default effort: ${prefs.defaultEffort ?? 'default'}`)
    return showSettings(topicId)
  }
  if (data === 'm:sdf') { await ack(); return showDefaultFolderPicker(topicId, 0) }
  const sdfp = /^m:sdfp:(\d+)$/.exec(data)
  if (sdfp) { await ack(); return showDefaultFolderPicker(topicId, Number(sdfp[1])) }
  const sdfi = /^m:sdfi:(\d+)$/.exec(data)
  if (sdfi) {
    const f = defaultFolderChoices[Number(sdfi[1])]
    if (f) { prefs.defaultCwd = f; savePrefs() }
    await ack(f ? basename(f) : 'expired')
    return showSettings(topicId)
  }

  // Pagination.
  const sp = /^m:spage:(\d+)$/.exec(data)
  if (sp) { await ack(); return showSessions(topicId, Number(sp[1])) }
  const fp = /^m:fpage:(\d+)$/.exec(data)
  if (fp) { await ack(); return renderFolderPage(uid, topicId, Number(fp[1])) }

  // Open a session from the list (short id) → bind to a topic and resume.
  const sess = /^m:sess:([0-9a-f]+)$/.exec(data)
  if (sess) {
    await ack('Opening…')
    const already = Object.values(registry).find(b => b.sessionId?.startsWith(sess[1]))
    if (already) return void paint(topicId, `📌 "${already.title}" is already open.`, backKb())
    await paint(topicId, '📎 Opening session…', backKb())
    const tid = await cmdAttach(sess[1], topicId)
    return void paint(topicId, tid ? '✅ Session opened.' : '⚠️ Could not open that session.', tid ? openLinkKb(tid) : backKb())
  }

  const nf = /^m:nf:(\d+)$/.exec(data)
  if (nf) {
    const w = wizard.get(uid)
    if (!w) return void ack('Expired — tap 🆕 again')
    w.cwd = w.folders[Number(nf[1])]
    w.step = 'model'
    await ack(basename(w.cwd || ''))
    return wizardModelStep(uid, topicId)
  }
  const nm = /^m:nm:(\w+)$/.exec(data)
  if (nm && isModelKey(nm[1])) {
    const w = wizard.get(uid)
    if (!w) return void ack('Expired — tap 🆕 again')
    w.model = MODELS[nm[1]]
    w.effort = undefined
    await ack(modelLabel(w.model))
    if (supportsEffort(w.model)) {
      w.step = 'effort'
      return wizardEffortStep(uid, topicId)
    }
    w.step = 'auto'
    return wizardAutoStep(uid, topicId)
  }
  if (data === 'm:nback') {
    // ⬅️ from the effort step: back to the model list, keeping the folder.
    const w = wizard.get(uid)
    if (!w) return void ack('Expired — tap 🆕 again')
    w.step = 'model'
    await ack()
    return wizardModelStep(uid, topicId)
  }
  const ne = /^m:ne:(\w+)$/.exec(data)
  if (ne && (ne[1] === 'auto' || parseEffort(ne[1]))) {
    const w = wizard.get(uid)
    if (!w) return void ack('Expired — tap 🆕 again')
    w.effort = parseEffort(ne[1])
    w.step = 'auto'
    await ack(`🎚 ${w.effort ?? 'default'}`)
    return wizardAutoStep(uid, topicId)
  }
  const na = /^m:na:(0|1)$/.exec(data)
  if (na) { await ack(na[1] === '1' ? '⚡ Auto' : '🔐 Approvals'); return finishWizard(uid, na[1] === '1') }

  // Topic controls (read the topic from the message the button is attached to).
  if (!topicId) return void ack()
  const tm = /^m:tm:(\w+)$/.exec(data)
  if (tm && isModelKey(tm[1])) {
    const b = registry[topicId]
    if (!b) return void ack('No session here')
    b.model = MODELS[tm[1]]
    saveRegistry()
    closeLive(topicId, 'model switch') // next message resumes with new model
    await ack(`Model: ${tm[1]}`)
    return paint(topicId, topicControlsText(b, '(applies on next message)'), topicControlsKb(b))
  }
  const te = /^m:te:(\w+)$/.exec(data)
  if (te && (te[1] === 'auto' || parseEffort(te[1]))) {
    const b = registry[topicId]
    if (!b) return void ack('No session here')
    b.effort = parseEffort(te[1])
    saveRegistry()
    closeLive(topicId, 'effort switch') // the level lives in the child env → new process
    await ack(`Effort: ${b.effort ?? 'default'}`)
    return paint(topicId, topicControlsText(b, '(applies on next message)'), topicControlsKb(b))
  }
  if (data === 'm:ta') {
    const b = registry[topicId]
    if (!b) return void ack('No session here')
    b.auto = !b.auto
    saveRegistry()
    await ack(b.auto ? '⚡ Auto ON' : '🔐 Approvals ON')
    return paint(topicId, topicControlsText(b), topicControlsKb(b))
  }
  // 💾 Close & keep — stop the session and close the topic, but keep everything
  // (resumable). The pinned panel becomes a Reopen button.
  if (data === 'm:tclose') {
    const b = registry[topicId]
    // Without this the pending nudge would resume the session — and post into
    // the topic the user just closed.
    cancelRateLimitResume(topicId)
    closeLive(topicId, 'closed & kept by user')
    if (b?.controlMsgId) await bot.api.unpinChatMessage(FORUM_CHAT_ID, b.controlMsgId).catch(() => {})
    await ack('💾 Closed')
    await paint(topicId, '💾 Session closed and saved — your context is kept. Reopen to resume.', new InlineKeyboard().text('♻️ Reopen & resume', 'm:treopen'))
    await bot.api.closeForumTopic(FORUM_CHAT_ID, Number(topicId)).catch(e => process.stderr.write(`[close] topic ${topicId}: ${e}\n`))
    return
  }
  // ♻️ Reopen a closed-but-kept topic and resume its session.
  if (data === 'm:treopen') {
    await bot.api.reopenForumTopic(FORUM_CHAT_ID, Number(topicId)).catch(e => process.stderr.write(`[reopen] topic ${topicId}: ${e}\n`))
    const b = registry[topicId]
    if (!b) return void paint(topicId, 'That session no longer exists.', backKb())
    await ensureLive(topicId)
    await ack('♻️ Reopened')
    await paint(topicId, topicControlsText(b), topicControlsKb(b))
    if (b.controlMsgId) await bot.api.pinChatMessage(FORUM_CHAT_ID, b.controlMsgId).catch(() => {})
    return
  }
  // 🗑 Close & delete — confirm first (irreversible).
  if (data === 'm:tdelete') {
    await ack()
    return paint(topicId, '🗑 Delete this topic and its session permanently?\nThis cannot be undone.', new InlineKeyboard().text('🗑 Yes, delete', 'm:tdelyes').text('↩️ Cancel', 'm:ctl'))
  }
  if (data === 'm:tdelyes') {
    cancelRateLimitResume(topicId)
    closeLive(topicId, 'deleted by user')
    delete registry[topicId]
    saveRegistry()
    await ack('🗑 Deleted')
    await bot.api.deleteForumTopic(FORUM_CHAT_ID, Number(topicId)).catch(e => process.stderr.write(`[delete] topic ${topicId}: ${e}\n`))
    return
  }
  // 🧹 Close, delete & remove all — full wipe (transcript + outbox too). Confirm first.
  if (data === 'm:twipe') {
    await ack()
    return paint(topicId, '🧹 Remove EVERYTHING for this topic — the session, its transcript (no longer resumable), delivered files, and the topic itself?\nThis cannot be undone.', new InlineKeyboard().text('🧹 Yes, wipe it all', 'm:twipeyes').text('↩️ Cancel', 'm:ctl'))
  }
  if (data === 'm:twipeyes') {
    const sid = registry[topicId]?.sessionId
    cancelRateLimitResume(topicId)
    closeLive(topicId, 'wiped by user')
    delete registry[topicId]
    saveRegistry()
    removeOutbox(topicId)
    if (sid) deleteTranscript(sid)
    primed.delete(topicId)
    await ack('🧹 Wiped')
    await bot.api.deleteForumTopic(FORUM_CHAT_ID, Number(topicId)).catch(e => process.stderr.write(`[wipe] topic ${topicId}: ${e}\n`))
    return
  }
  await ack()
}

const HELP = `Everything is buttons — you rarely need to type commands.

📋 GENERAL topic — send anything (or tap the blue Menu button) to open:
• 🆕 New session — pick a repo (from ${REPOS_DIR}), a model, an effort level, and approvals
• ⚡ Quick new — instant session in your default folder + model + effort
• 📋 My sessions — list past sessions; tap one to reopen it
• ▶️ Resume last — jump into the most recent session
• ⚙️ Settings — set the default model, effort + folder for new sessions
• ❓ Help — this text

💬 SESSION topic — just type your request. A 📌 pinned panel sits at the top of
every session topic with:
• 🐇 Haiku / ⚡ Sonnet / 🧠 Opus / ✨ Fable — switch model (applies next message)
• 🎚 low / med / high / xhigh / max / ↺ default — how hard it thinks (Haiku has none)
• 🔐 Approvals ↔ ⚡ Auto — toggle whether tools ask before running
• 💾 Close & keep — stop the session + close the topic, keep everything
   (a ♻️ Reopen button appears to resume later with full context)
• 🗑 Close & delete — remove the topic + session (transcript stays on disk)
• 🧹 Close, delete & remove all — wipe everything: topic, session, delivered
   files, and the transcript (no longer resumable)

🖼️ Files both ways:
• Claude can send you images/files — they appear right in the topic.
• Send a photo or file into a topic and the session can read it.

❓ Questions & plans:
• Clarifying questions appear as tappable options (or type your own answer).
• A proposed plan is shown, then you tap ✅ Allow / ❌ Deny.
• Risky tools (Bash/Write/Edit/Web) ask ✅ Allow / ❌ Deny — unless ⚡ auto is on.`

// ── Message routing ───────────────────────────────────────────────────────────
async function handleText(ctx: Context, text: string): Promise<void> {
  const topicId = ctx.message?.message_thread_id ? String(ctx.message.message_thread_id) : undefined
  process.stderr.write(`[in] recv topic=${topicId ?? 'general'} len=${text.length}\n`)

  if (text.startsWith('/')) {
    const [cmd, ...rest] = text.slice(1).split(/\s+/)
    const args = rest.join(' ')
    switch (cmd) {
      case 'new': return cmdNew(args, topicId)
      case 'list': return showSessions(topicId, 0)
      case 'attach': return void (await cmdAttach(args, topicId))
      case 'auto': return cmdAuto(args, topicId)
      case 'menu':
        // In a bound topic → controls; in General → main menu.
        return topicId && registry[topicId] ? showTopicControls(topicId) : showMainMenu(topicId)
      case 'help': return void sayTopic(topicId, HELP)
      case 'start': return showMainMenu(topicId)
      default: return showMainMenu(topicId)
    }
  }

  if (!topicId) {
    // Plain text in General → just show the menu (dummy-proof).
    await showMainMenu(undefined)
    return
  }
  // If a clarifying question is pending in this topic, a typed reply is the
  // free-text answer (the documented AskUserQuestion `response` path).
  const ft = askFreeText.get(topicId)
  if (ft) return void ft(text)
  // `use fable high`, `use opus`, `effort max`, `effort default`.
  const useModel = /^use (\w+)(?:\s+(\w+))?$/i.exec(text)
  if (useModel && isModelKey(useModel[1].toLowerCase()) && (!useModel[2] || parseEffort(useModel[2]))) {
    return setModel(topicId, useModel[1].toLowerCase(), parseEffort(useModel[2]))
  }
  const useEffort = /^effort (\w+)$/i.exec(text)
  if (useEffort && (useEffort[1].toLowerCase() === 'default' || parseEffort(useEffort[1]))) {
    return setEffort(topicId, parseEffort(useEffort[1]))
  }
  // Typed in a topic with no session → offer a one-tap "start here".
  if (!registry[topicId]) {
    await send(topicId, 'This topic has no Claude session yet.', new InlineKeyboard().text('🆕 Start a session here', 'm:newhere'))
    return
  }
  await sendToTopic(topicId, text)
}

bot.on('message:text', async ctx => {
  if (!allowed(ctx)) return
  await handleText(ctx, ctx.message.text)
})

bot.on('message:photo', async ctx => {
  if (!allowed(ctx)) return
  const topicId = ctx.message.message_thread_id ? String(ctx.message.message_thread_id) : undefined
  if (!topicId) return void sayTopic(undefined, 'Send images inside a session topic.')
  try {
    const best = ctx.message.photo[ctx.message.photo.length - 1] // largest size
    const file = await ctx.api.getFile(best.file_id)
    const url = `https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`
    const buf = Buffer.from(await (await fetch(url)).arrayBuffer())
    mkdirSync(INBOX_DIR, { recursive: true })
    const path = join(INBOX_DIR, `${Date.now()}-${best.file_unique_id}.jpg`)
    writeFileSync(path, buf)
    const caption = ctx.message.caption?.trim()
    await sayTopic(topicId, '🖼️ image received')
    await sendToTopic(topicId, `The user sent an image, saved at ${path} — Read it to see it.${caption ? `\nCaption: ${caption}` : ''}`)
  } catch (e) {
    await sayTopic(topicId, `image handling failed: ${e}`)
  }
})

bot.on('message:document', async ctx => {
  if (!allowed(ctx)) return
  const topicId = ctx.message.message_thread_id ? String(ctx.message.message_thread_id) : undefined
  if (!topicId) return void sayTopic(undefined, 'Send files inside a session topic.')
  const doc = ctx.message.document
  try {
    if (doc.file_size && doc.file_size > 20 * 1024 * 1024) {
      await sayTopic(topicId, `File too large (${(doc.file_size / 1048576).toFixed(1)} MB) — Telegram caps bot downloads at 20 MB.`)
      return
    }
    const file = await ctx.api.getFile(doc.file_id)
    const url = `https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`
    const buf = Buffer.from(await (await fetch(url)).arrayBuffer())
    mkdirSync(INBOX_DIR, { recursive: true })
    const safeName = (doc.file_name || `${Date.now()}.bin`).replace(/[^\w.\-]/g, '_')
    const path = join(INBOX_DIR, `${Date.now()}-${safeName}`)
    writeFileSync(path, buf)
    const caption = ctx.message.caption?.trim()
    await sayTopic(topicId, `📎 file received: ${doc.file_name ?? safeName}`)
    await sendToTopic(topicId, `The user sent a file "${doc.file_name ?? safeName}" (${doc.mime_type ?? 'unknown type'}), saved at ${path} — Read it.${caption ? `\nCaption: ${caption}` : ''}`)
  } catch (e) {
    await sayTopic(topicId, `file handling failed: ${e}`)
  }
})

bot.on('callback_query:data', async ctx => {
  const data = ctx.callbackQuery.data || ''
  // Same gate as inbound messages: right user AND right chat (defense-in-depth —
  // buttons are only ever posted into FORUM_CHAT_ID).
  if (String(ctx.from.id) !== ALLOWED_USER_ID || String(ctx.chat?.id) !== FORUM_CHAT_ID) {
    return void ctx.answerCallbackQuery({ text: 'Not authorized.' }).catch(() => {})
  }

  // Menu / wizard / topic-control buttons. menuCtx makes menu screens repaint
  // the tapped message in place; clear it after so typed commands send fresh.
  if (data.startsWith('m:')) {
    menuCtx = ctx
    try {
      await handleMenu(ctx, data)
    } finally {
      menuCtx = undefined
    }
    return
  }

  // Clarifying-question buttons: qa:<token>:<optionIndex|done>
  const qm = /^qa:([0-9a-z]+):(\d+|done)$/.exec(data)
  if (qm) {
    const b = askBtns.get(qm[1])
    if (!b) return void ctx.answerCallbackQuery({ text: 'Expired.' }).catch(() => {})
    if (qm[2] === 'done') {
      askBtns.delete(qm[1])
      b.resolve([...b.selected].sort((a, z) => a - z).map(i => b.options[i].label))
      await ctx.answerCallbackQuery({ text: '✅ Submitted' }).catch(() => {})
      await bot.api.editMessageReplyMarkup(FORUM_CHAT_ID, b.messageId, { reply_markup: undefined }).catch(() => {})
    } else if (b.multi) {
      const i = Number(qm[2])
      if (b.selected.has(i)) b.selected.delete(i); else b.selected.add(i)
      await bot.api.editMessageReplyMarkup(FORUM_CHAT_ID, b.messageId, { reply_markup: askKeyboard(qm[1], b.options, true, b.selected) }).catch(() => {})
      await ctx.answerCallbackQuery({ text: b.selected.has(i) ? 'added' : 'removed' }).catch(() => {})
    } else {
      askBtns.delete(qm[1])
      const label = b.options[Number(qm[2])].label
      b.resolve(label)
      await ctx.answerCallbackQuery({ text: `✓ ${label}`.slice(0, 200) }).catch(() => {})
      await bot.api.editMessageReplyMarkup(FORUM_CHAT_ID, b.messageId, { reply_markup: undefined }).catch(() => {})
    }
    return
  }

  const m = /^p:([0-9a-z]+):(a|d)$/.exec(data)
  if (!m) return void ctx.answerCallbackQuery().catch(() => {})
  const entry = pending.get(m[1])
  if (!entry) return void ctx.answerCallbackQuery({ text: 'Expired.' }).catch(() => {})
  pending.delete(m[1])
  const allow = m[2] === 'a'
  // Omit updatedInput on allow → the tool runs with its ORIGINAL input (command,
  // file, plan). Passing {} would replace the input with nothing.
  entry.resolve(allow ? { behavior: 'allow' } : { behavior: 'deny', message: 'denied by user' })
  await ctx.answerCallbackQuery({ text: allow ? '✅ Allowed' : '❌ Denied' }).catch(() => {})
  if (entry.messageId) {
    await bot.api
      .editMessageReplyMarkup(FORUM_CHAT_ID, entry.messageId, { reply_markup: undefined })
      .catch(() => {})
  }
})

bot.catch(err => process.stderr.write(`grammy error (polling continues): ${err.error}\n`))

// Without these, one stray rejection/throw silently wedges the process (the SDK
// child + timers keep bun alive, so systemd never restarts it). Log and keep serving.
process.on('unhandledRejection', e => process.stderr.write(`unhandledRejection: ${e}\n`))
process.on('uncaughtException', e => process.stderr.write(`uncaughtException: ${e}\n`))

// On a clean stop (Ctrl+C / SIGTERM), close every live session so their
// `claude` children exit too — no orphaned processes left behind.
let shuttingDown = false
function shutdown(sig: string): void {
  if (shuttingDown) return
  shuttingDown = true
  process.stderr.write(`\n${sig}: closing ${live.size} live session(s)…\n`)
  for (const l of [...live.values()]) {
    try {
      l.session.close()
    } catch {}
  }
  try {
    bot.stop()
  } catch {}
  process.exit(0)
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

// ── Boot ──────────────────────────────────────────────────────────────────────
await bot.api.setMyCommands([
  { command: 'menu', description: 'Open the menu — everything is buttons' },
])
process.stderr.write(
  `telepath up — chat ${FORUM_CHAT_ID}, user ${ALLOWED_USER_ID}, ` +
    `default ${prefs.defaultModel} @ effort ${prefs.defaultEffort ?? 'default'}, models ${ENABLED_MODELS.join(',')}, cap ${MAX_LIVE_SESSIONS}, idle ${IDLE_MINUTES}m\n` +
    `  claude binary: ${CLAUDE_BIN}\n`,
)
bot.start({
  onStart: i => {
    process.stderr.write(`polling as @${i.username}\n`)
  },
})
