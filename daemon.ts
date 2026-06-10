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
import { Bot, InlineKeyboard, type Context } from 'grammy'
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync, statSync, chmodSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

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
const SONNET_MODEL = process.env.SONNET_MODEL || 'claude-sonnet-4-6'
const OPUS_MODEL = process.env.OPUS_MODEL || 'claude-opus-4-8'
const FABLE_MODEL = process.env.FABLE_MODEL || 'claude-fable-5'
const MODELS: Record<string, string> = { sonnet: SONNET_MODEL, opus: OPUS_MODEL, fable: FABLE_MODEL }
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || SONNET_MODEL
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
  const variants = [
    'claude-agent-sdk-linux-x64', 'claude-agent-sdk-linux-x64-musl',
    'claude-agent-sdk-linux-arm64', 'claude-agent-sdk-darwin-x64', 'claude-agent-sdk-darwin-arm64',
  ]
  for (const v of variants) {
    const p = join(import.meta.dir, 'node_modules', '@anthropic-ai', v, 'claude')
    if (existsSync(p)) return p
  }
  return 'claude' // rely on PATH
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
type Binding = { sessionId?: string; cwd: string; model: string; title: string; lastActive: number; auto?: boolean }
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
function chunk(text: string, limit = 4000): string[] {
  if (!text) return []
  if (text.length <= limit) return [text]
  const out: string[] = []
  let rest = text
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit)
    if (cut < limit / 2) cut = rest.lastIndexOf(' ', limit)
    if (cut < 1) cut = limit
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest) out.push(rest)
  return out
}

async function sayTopic(topicId: string | undefined, text: string): Promise<void> {
  const opts = topicId ? { message_thread_id: Number(topicId) } : {}
  for (const part of chunk(text)) {
    try {
      await bot.api.sendMessage(FORUM_CHAT_ID, part, opts)
      process.stderr.write(`[out] sent topic ${topicId} ${part.length}c\n`)
    } catch (e) {
      process.stderr.write(`[out] send FAILED topic ${topicId}: ${e}\n`)
    }
  }
}

// ── Clarifying questions (AskUserQuestion) ──────────────────────────────────
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
async function askApprove(topicId: string, promptText: string): Promise<PermissionResult> {
  const token = permToken()
  const kb = new InlineKeyboard().text('✅ Allow', `p:${token}:a`).text('❌ Deny', `p:${token}:d`)
  let messageId: number | undefined
  try {
    const sent = await bot.api.sendMessage(FORUM_CHAT_ID, promptText, { message_thread_id: Number(topicId), reply_markup: kb })
    messageId = sent.message_id
  } catch (e) {
    process.stderr.write(`approval prompt send failed: ${e}\n`)
    return { behavior: 'deny', message: 'could not deliver approval prompt' }
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

    const label = opts.displayName || toolName
    const detail = opts.description ? `\n${opts.description}` : summarizeInput(toolName, input)
    return askApprove(topicId, `🔐 ${label}${detail}`)
  }
}

function summarizeInput(tool: string, input: Record<string, unknown>): string {
  if (tool === 'Bash' && typeof input.command === 'string') return `\n\`${String(input.command).slice(0, 300)}\``
  if ((tool === 'Write' || tool === 'Edit') && typeof input.file_path === 'string') return `\n${input.file_path}`
  const s = JSON.stringify(input)
  return s.length > 200 ? `\n${s.slice(0, 200)}…` : `\n${s}`
}

// ── Stream pump: forward a session's output into its topic ───────────────────
async function pump(l: Live): Promise<void> {
  l.pumping = true
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
        process.stderr.write(`[pump] topic ${l.topicId} rate_limit_event (may end the stream)\n`)
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
        if ((msg as any).subtype !== 'success' || (msg as any).is_error) {
          await sayTopic(l.topicId, `⚠️ turn ended: ${(msg as any).subtype}`)
        }
      }
    }
  } catch (e) {
    await sayTopic(l.topicId, `⚠️ session error: ${e}`)
  } finally {
    l.pumping = false
    // The session's stream ended (it closed, crashed, or completed). Evict the
    // dead handle so the NEXT message resumes a fresh session instead of being
    // silently swallowed by a stale, dead session.send(). (idempotent vs closeLive)
    if (live.get(l.topicId) === l) {
      live.delete(l.topicId)
      process.stderr.write(`topic ${l.topicId}: session stream ended, evicted (resumes on next message)\n`)
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

function sessionOptions(cwd: string, model: string, topicId: string) {
  return {
    model,
    cwd,
    env: CHILD_ENV,
    pathToClaudeCodeExecutable: CLAUDE_BIN,
    settingSources: SETTING_SOURCES,
    permissionMode: 'default' as const,
    allowedTools: [...AUTO_ALLOW],
    canUseTool: makeCanUseTool(topicId),
  }
}

function enforceCap(): void {
  while (live.size >= MAX_LIVE_SESSIONS) {
    let oldest: Live | undefined
    for (const l of live.values()) if (!oldest || l.lastActive < oldest.lastActive) oldest = l
    if (!oldest) break
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
  const opts = sessionOptions(b.cwd, b.model, topicId)
  const session = b.sessionId
    ? unstable_v2_resumeSession(b.sessionId, opts)
    : unstable_v2_createSession(opts)
  const l: Live = { session, topicId, model: b.model, cwd: b.cwd, lastActive: Date.now(), pumping: false }
  live.set(topicId, l)
  void pump(l)
  return l
}

async function sendToTopic(topicId: string, text: string): Promise<void> {
  let l = await ensureLive(topicId)
  if (!l) {
    await sayTopic(topicId, 'No session bound to this topic. Use /new (or /attach) first.')
    return
  }
  l.lastActive = Date.now()
  await bot.api.sendChatAction(FORUM_CHAT_ID, 'typing', { message_thread_id: Number(topicId) }).catch(() => {})
  try {
    await l.session.send(text)
  } catch (e) {
    // Stale/dead handle slipped through — evict and resume once.
    process.stderr.write(`topic ${topicId}: send failed (${e}); recreating session\n`)
    live.delete(topicId)
    const l2 = await ensureLive(topicId)
    if (!l2) return
    l = l2
    await l.session.send(text)
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
  let cwd = DEFAULT_CWD
  let auto = false
  const kept: string[] = []
  for (const t of args.trim().split(/\s+/).filter(Boolean)) {
    if (t.startsWith('cwd=')) {
      const cand = expandHome(t.slice(4))
      if (existsSync(cand) && statSync(cand).isDirectory()) cwd = cand
      else notify(`(ignoring cwd="${cand}" — not a directory; using ${DEFAULT_CWD})`)
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
  registry[topicId] = { cwd, model: DEFAULT_MODEL, title: name, lastActive: Date.now(), auto }
  saveRegistry()
  await ensureLive(topicId)
  await sayTopic(topicId, `🆕 "${name}" · ${DEFAULT_MODEL}${auto ? ' · ⚡auto' : ''} · cwd ${cwd}\nSend a message to start. "use fable"/"use opus"/"use sonnet" switches model; /auto toggles approvals.`)
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

async function cmdList(toTopic: string | undefined): Promise<void> {
  let sessions
  try {
    sessions = await listSessions()
  } catch (e) {
    await sayTopic(toTopic, `listSessions failed: ${e}`)
    return
  }
  const boundIds = new Set(Object.values(registry).map(b => b.sessionId).filter(Boolean))
  const rows = sessions
    .sort((a, b) => b.lastModified - a.lastModified)
    .slice(0, 20)
    .map(s => {
      const sid = s.sessionId.slice(0, 8)
      const when = new Date(s.lastModified).toISOString().slice(5, 16).replace('T', ' ')
      const liveMark = [...live.values()].some(l => registry[l.topicId]?.sessionId === s.sessionId) ? ' 🟢' : ''
      const bound = boundIds.has(s.sessionId) ? ' 📌' : ''
      const title = (s.customTitle || s.summary || s.firstPrompt || '(untitled)').slice(0, 60)
      return `\`${sid}\` ${when}${liveMark}${bound} — ${title}`
    })
  await sayTopic(toTopic, rows.length ? `Recent sessions:\n${rows.join('\n')}` : 'No sessions found.')
}

async function cmdAttach(args: string, fromTopic: string | undefined): Promise<void> {
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
    model: DEFAULT_MODEL,
    title: name,
    lastActive: Date.now(),
  }
  saveRegistry()
  await sayTopic(topicId, `📎 Attached session \`${match.sessionId.slice(0, 8)}\`. Send a message to continue it.`)
}

async function setModel(topicId: string, which: keyof typeof MODELS): Promise<void> {
  const b = registry[topicId]
  if (!b) {
    await sayTopic(topicId, 'No session bound here.')
    return
  }
  b.model = MODELS[which]
  saveRegistry()
  closeLive(topicId, 'model switch') // next message resumes with new model
  await sayTopic(topicId, `Model set to ${b.model}. (applies on next message)`)
}

const HELP = `Commands (use in the General topic):
/new <name> [cwd=/path] [auto] — create a topic + session (add "auto" to skip approvals)
/list — recent sessions (📌 bound, 🟢 live)
/attach <short-id> [name] — bind an existing session to a new topic
/auto [on|off] — toggle auto mode for the current topic (no Allow/Deny prompts)
/help

In a session topic: just type. "use fable" / "use opus" / "use sonnet" switches model.
Clarifying questions show as option buttons — tap one, or type your own reply.
Risky tools (Bash/Write/Edit/Web) ask for Allow/Deny unless the topic is in /auto.`

// ── Message routing ───────────────────────────────────────────────────────────
async function handleText(ctx: Context, text: string): Promise<void> {
  const topicId = ctx.message?.message_thread_id ? String(ctx.message.message_thread_id) : undefined
  process.stderr.write(`[in] recv topic=${topicId ?? 'general'} len=${text.length}\n`)

  if (text.startsWith('/')) {
    const [cmd, ...rest] = text.slice(1).split(/\s+/)
    const args = rest.join(' ')
    switch (cmd) {
      case 'new': return cmdNew(args, topicId)
      case 'list': return cmdList(topicId)
      case 'attach': return cmdAttach(args, topicId)
      case 'auto': return cmdAuto(args, topicId)
      case 'help':
      case 'start': return void sayTopic(topicId, HELP)
      default: return void sayTopic(topicId, `Unknown command. ${HELP}`)
    }
  }

  if (!topicId) {
    await sayTopic(undefined, `Type in a session topic, or run a command.\n\n${HELP}`)
    return
  }
  // If a clarifying question is pending in this topic, a typed reply is the
  // free-text answer (the documented AskUserQuestion `response` path).
  const ft = askFreeText.get(topicId)
  if (ft) return void ft(text)
  const useModel = /^use (opus|sonnet|fable)$/i.exec(text)
  if (useModel) return setModel(topicId, useModel[1].toLowerCase() as keyof typeof MODELS)
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
  if (String(ctx.from.id) !== ALLOWED_USER_ID) {
    return void ctx.answerCallbackQuery({ text: 'Not authorized.' }).catch(() => {})
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
  entry.resolve(allow ? { behavior: 'allow', updatedInput: {} } : { behavior: 'deny', message: 'denied by user' })
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

// ── Boot ──────────────────────────────────────────────────────────────────────
await bot.api.setMyCommands([
  { command: 'new', description: 'Create a topic + Claude session' },
  { command: 'list', description: 'List recent sessions' },
  { command: 'attach', description: 'Attach an existing session to a topic' },
  { command: 'auto', description: 'Toggle auto mode (no approvals) for this topic' },
  { command: 'help', description: 'Show help' },
])
process.stderr.write(
  `telepath up — chat ${FORUM_CHAT_ID}, user ${ALLOWED_USER_ID}, ` +
    `default ${DEFAULT_MODEL}, cap ${MAX_LIVE_SESSIONS}, idle ${IDLE_MINUTES}m\n` +
    `  claude binary: ${CLAUDE_BIN}\n`,
)
bot.start({
  onStart: i => {
    process.stderr.write(`polling as @${i.username}\n`)
  },
})
