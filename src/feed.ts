/**
 * Activity feed: what a session is DOING, as a compact digest.
 *
 * A topic in auto mode posts no approval prompts, and a model deep in a long autonomous
 * task can go an hour with a single sentence of text. Measured on a real transcript: 277
 * tool calls, 1 text block, in one hour. The feed is the deterministic substitute for the
 * commentary the model does not give.
 *
 * The first version sent one line per tool call and was read on a phone as spam: file
 * names of a machine the reader cannot reach, one message per edit because calls arrive
 * seconds apart. So the feed is a digest: commands and subagent briefs are readable and
 * kept as lines; edits collapse to one line with a count; reads and searches are a count
 * only. The digest is rendered inside the turn's live status message (status.ts).
 * Pure functions here.
 */
import { basename } from 'path'

const MAX = 160

function oneLine(s: string, max = MAX): string {
  const t = s.replace(/\s*\n\s*/g, ' ').replace(/\s+/g, ' ').trim()
  return t.length > max ? t.slice(0, max - 1) + '…' : t
}

function fileName(p: unknown): string {
  return typeof p === 'string' && p ? basename(p.replace(/\\/g, '/')) : '?'
}

/**
 * Commands are shown by their text when the model gave no description, and a command
 * can carry a credential (`curl -H "Authorization: Bearer …"`, `TOKEN=… ./deploy`). The
 * chat is private and the approval prompt already shows commands, but the status message
 * is edited repeatedly and stays visible, so obvious secrets are masked by shape. This is
 * masking by identity of well-known formats, not an entropy heuristic: a git SHA or a
 * device id keeps its face.
 */
// key, optional closing quote of a JSON key, separator, optional opening quote, value
// (optionally prefixed by the word Bearer), matching closing quote.
// The separator must be `=` or `:`: a bare space would turn ordinary prose such as
// "audit the auth routes" into a redaction. A bearer token after "Bearer " is caught
// by its own pattern below.
const KEYED_SECRET = /\b(token|secret|password|passwd|pwd|api[_-]?key|apikey|authorization|client[_-]?secret|access[_-]?key)\b(["']?)(\s*[=:]\s*)(["']?)(?:Bearer\s+)?[^\s"']{4,}\4/gi
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g
const SHAPED_SECRET =
  /\b(sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|glsa_[A-Za-z0-9_]{20,}|FlyV1\s+\S+|AIza[0-9A-Za-z_-]{30,})/g
// A Telegram bot token (`<digits>:<35 chars>`) usually follows "bot" in a URL, so no word
// boundary can precede it.
const BOT_TOKEN = /\d{6,}:[A-Za-z0-9_-]{30,}/g

export function redactSecrets(s: string): string {
  return s
    .replace(KEYED_SECRET, (_m, key: string, q: string, sep: string) => `${key}${q}${sep}[redacted]`)
    .replace(BEARER, 'Bearer [redacted]')
    .replace(SHAPED_SECRET, '[redacted]')
    .replace(BOT_TOKEN, '[redacted]')
}

export type FeedItem = {
  kind: 'command' | 'edit' | 'read' | 'search' | 'web' | 'agent' | 'task' | 'other'
  /** Short human label: a command's description, a file's basename, a brief. */
  label: string
  /** Runs in the background (a later "done" line refers to it). */
  background?: boolean
  /** Issued by a subagent, not the main thread. */
  sub?: boolean
}

/** One item for a tool call. Never the raw input. */
export function toolItem(name: string, input: Record<string, unknown> | undefined): FeedItem {
  const i = input ?? {}
  switch (name) {
    case 'Bash':
    case 'PowerShell': {
      // The description is the model's prose, but it can echo the command's credential
      // ("Deploy with token sk-…"), so it is masked the same way.
      const what = typeof i.description === 'string' && i.description ? i.description : String(i.command ?? '')
      return { kind: 'command', label: oneLine(redactSecrets(what)), background: !!i.run_in_background }
    }
    case 'Read':
      return { kind: 'read', label: fileName(i.file_path) }
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
    case 'Write':
      return { kind: 'edit', label: fileName(i.file_path ?? i.notebook_path) }
    case 'Grep':
    case 'Glob':
      return { kind: 'search', label: oneLine(String(i.pattern ?? ''), 60) }
    case 'WebFetch':
      return { kind: 'web', label: oneLine(redactSecrets(String(i.url ?? '')), 100) }
    case 'WebSearch':
      return { kind: 'web', label: oneLine(redactSecrets(String(i.query ?? '')), 100) }
    case 'Agent':
    case 'Task':
      return { kind: 'agent', label: oneLine(redactSecrets(String(i.description ?? i.prompt ?? ''))) }
    default: {
      let brief = ''
      try {
        brief = JSON.stringify(i)
      } catch {}
      return { kind: 'other', label: oneLine(redactSecrets(`${name} ${brief}`), 100) }
    }
  }
}

/** Items for one assistant message's content blocks: tool calls only. */
export function feedItems(content: unknown, sub = false): FeedItem[] {
  if (!Array.isArray(content)) return []
  return content
    .filter((b: any) => b?.type === 'tool_use')
    .map((b: any) => ({ ...toolItem(String(b.name ?? '?'), b.input), ...(sub ? { sub: true } : {}) }))
}

/**
 * One line for a task event the SDK reports itself: a subagent or background command
 * starting, or a background task settling.
 */
export function describeTask(status: 'started' | 'completed' | 'failed' | 'stopped', description: string, background: boolean): string {
  const what = description || 'task'
  switch (status) {
    case 'started':
      return oneLine(`${background ? '⏳' : '🤖'} started: ${what}`)
    case 'completed':
      return oneLine(`✅ done: ${what}`)
    case 'failed':
      return oneLine(`❌ failed: ${what}`)
    case 'stopped':
      return oneLine(`⏹ stopped: ${what}`)
  }
}

const LIST_CAP = 5
const NAMES_CAP = 3

function listOf(labels: string[], cap = NAMES_CAP): string {
  const uniq = [...new Set(labels)]
  const shown = uniq.slice(0, cap).join(', ')
  return uniq.length > cap ? `${shown} +${uniq.length - cap}` : shown
}

/**
 * The digest: commands, subagents, web calls and task lines stay one per line (their
 * labels are what a reader can act on); edits collapse to one line naming a few files
 * and counting the rest; reads and searches are a count only. Order of the kept lines
 * follows the order the calls were made. Empty input → no lines.
 */
export function digest(items: FeedItem[]): string[] {
  if (!items.length) return []
  const lines: string[] = []
  const edits: string[] = []
  let reads = 0
  let searches = 0
  let hidden = 0
  const sub = (it: FeedItem) => (it.sub ? '↳ ' : '')
  for (const it of items) {
    switch (it.kind) {
      case 'command':
        if (lines.length < LIST_CAP) lines.push(`${sub(it)}🖥 ${it.label}${it.background ? ' ⏳' : ''}`)
        else hidden++
        break
      case 'agent':
        if (lines.length < LIST_CAP) lines.push(`${sub(it)}🤖 ${it.label}`)
        else hidden++
        break
      case 'web':
        if (lines.length < LIST_CAP) lines.push(`${sub(it)}🌐 ${it.label}`)
        else hidden++
        break
      case 'task':
        if (lines.length < LIST_CAP) lines.push(`${sub(it)}${it.label}`)
        else hidden++
        break
      case 'other':
        if (lines.length < LIST_CAP) lines.push(`${sub(it)}🔧 ${it.label}`)
        else hidden++
        break
      case 'edit':
        edits.push(it.label)
        break
      case 'read':
        reads++
        break
      case 'search':
        searches++
        break
    }
  }
  if (hidden) lines.push(`… +${hidden} more`)
  // Distinct files, not edit calls: five edits to one file are one file edited.
  const files = [...new Set(edits)]
  if (files.length) lines.push(`✏️ ${files.length === 1 ? 'edited' : `edited ${files.length} files:`} ${listOf(files)}`)
  const counts: string[] = []
  if (reads) counts.push(`📖 ${reads} read${reads === 1 ? '' : 's'}`)
  if (searches) counts.push(`🔍 ${searches} search${searches === 1 ? '' : 'es'}`)
  if (counts.length) lines.push(counts.join(' · '))
  return lines
}
