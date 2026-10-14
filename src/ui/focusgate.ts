/**
 * The Focus gate: before a NEW topic starts while three or more work items are in flight,
 * ask once (resume one, park one, or start anyway). It is soft by design: Start anyway is
 * always one tap away.
 *
 * The item logic (what counts as in flight, the limit, what waits on Rohan) lives in the
 * external focus tool, ~/.claude/scripts/focus/focus.py, which has its own suite. This
 * module only reads the tool's answer, holds the creation the prompt interrupted, and
 * decides what a tap does; src/focus.ts runs the tool and src/bot.ts wires both to Telegram.
 */
import { randomBytes } from 'crypto'
import type { Effort } from '../models'

/** How long a prompt's buttons stay good. Long enough to read, short enough not to surprise. */
export const GATE_TTL_MS = 30 * 60_000
/** Item rows on the prompt; the rest are counted ("…and 2 more"). */
export const GATE_ROWS = 5
/** A non-telepath item is offered for attaching here only when idle this long, so a session still open in VS Code never gets a second writer. */
export const ATTACH_IDLE_MIN = 30

export type GateItem = {
  num: number
  id: string
  title: string
  source: string | null
  topicId: string | null
  cwd: string | null
  idleMin: number | null
  waiting: boolean
  state: string
  /** How to get back into it: a topic link, or a resume command. Printed, never run. */
  resume: string
}
export type GateView = { gate: boolean; limit: number; inFlight: number; items: GateItem[]; more: number }

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)

/** The tool's `gate --json` answer, or undefined for anything that is not one. Never throws. */
export function parseGateView(raw: string): GateView | undefined {
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined
  const o = v as Record<string, unknown>
  if (typeof o.gate !== 'boolean' || !Array.isArray(o.items)) return undefined
  const items: GateItem[] = []
  for (const it of o.items) {
    if (!it || typeof it !== 'object') return undefined
    const i = it as Record<string, unknown>
    if (typeof i.num !== 'number' || typeof i.id !== 'string') return undefined
    items.push({
      num: i.num,
      id: i.id,
      title: str(i.title) ?? `#${i.num}`,
      source: str(i.source),
      topicId: str(i.topicId),
      cwd: str(i.cwd),
      idleMin: typeof i.idleMin === 'number' ? i.idleMin : null,
      waiting: i.waiting === true,
      state: str(i.state) ?? 'open',
      resume: str(i.resume) ?? '',
    })
  }
  return { gate: o.gate, limit: num(o.limit, 3), inFlight: num(o.inFlight, items.length), items, more: num(o.more, 0) }
}

/**
 * Where a session can be started. Only the first four start a NEW item; the rest reopen
 * one that exists, which is resuming, so gating them would block the gate's own Resume.
 */
export type EntryKind = 'new' | 'quick' | 'wizard' | 'newhere' | 'attach' | 'resume' | 'sess'
const GATED: ReadonlySet<EntryKind> = new Set<EntryKind>(['new', 'quick', 'wizard', 'newhere'])

export function gatedEntry(kind: EntryKind): boolean {
  return GATED.has(kind)
}

/** No tool, no answer, or an answer under the limit: no prompt. */
export function shouldGate(view: GateView | undefined, enabled: boolean): boolean {
  return enabled && !!view && view.gate
}

const SOURCE: Record<string, string> = { vscode: 'VS Code', cli: 'terminal', telepath: 'telepath' }

function ago(min: number): string {
  if (min < 60) return `${Math.max(0, Math.floor(min))}m`
  if (min < 48 * 60) return `${Math.floor(min / 60)}h`
  return `${Math.floor(min / 1440)}d`
}

export function gateText(v: GateView): string {
  const lines = [`🎯 You have ${v.inFlight} threads in flight; your limit is ${v.limit}.`]
  for (const i of v.items.slice(0, GATE_ROWS)) {
    const bits = [SOURCE[i.source ?? ''] ?? i.source ?? '?']
    if (i.state === 'active') bits.push("today's focus")
    if (i.waiting) bits.push('waiting on you')
    if (i.idleMin !== null) bits.push(`idle ${ago(i.idleMin)}`)
    lines.push(`#${i.num} ${i.title} · ${bits.join(' · ')}`)
  }
  if (v.more > 0) lines.push(`…and ${v.more} more.`)
  lines.push('', 'Resume one, park one to make room, or start this anyway.')
  return lines.join('\n')
}

/** The creation a prompt interrupted, kept so Start anyway / Park can finish it exactly. */
export type HeldCreation = {
  kind: 'new' | 'quick' | 'wizard' | 'newhere'
  uid: string
  /** Where the request came from (General when undefined); `newhere` binds this topic. */
  topicId?: string
  name?: string
  cwd?: string
  model?: string
  effort?: Effort
  auto?: boolean
  /** The items the prompt showed, so a tap's index means what Rohan saw. */
  view: GateView
}

/**
 * Held creations under random, single-use, expiring tokens. Random, not a counter: a
 * counter restarts with the daemon, and an old button would then match a new prompt.
 */
export class HeldCreations {
  private readonly held = new Map<string, { h: HeldCreation; at: number }>()
  private readonly now: () => number
  private readonly token: () => string
  private readonly ttlMs: number

  constructor(o: { now?: () => number; token?: () => string; ttlMs?: number } = {}) {
    this.now = o.now ?? Date.now
    this.token = o.token ?? (() => randomBytes(6).toString('hex'))
    this.ttlMs = o.ttlMs ?? GATE_TTL_MS
  }

  hold(h: HeldCreation): string {
    const now = this.now()
    for (const [t, e] of this.held) if (now - e.at > this.ttlMs) this.held.delete(t)
    let t = this.token()
    while (this.held.has(t)) t = this.token()
    this.held.set(t, { h, at: now })
    return t
  }

  /** Single use: the entry is gone after this, whatever it returns. */
  take(token: string): HeldCreation | undefined {
    const e = this.held.get(token)
    this.held.delete(token)
    if (!e || this.now() - e.at > this.ttlMs) return undefined
    return e.h
  }
}

export type GateTap =
  | { token: string; action: 'go' }
  | { token: string; action: 'parkidle' }
  | { token: string; action: 'cancel' }
  | { token: string; action: 'park'; index: number }
  | { token: string; action: 'resume'; index: number }

const TAP_RE = /^m:fg:([0-9a-z]+):(?:(go|pi|x)|p:(\d+)|r:(\d+))$/

export function parseGateTap(data: string): GateTap | undefined {
  const m = TAP_RE.exec(data)
  if (!m) return undefined
  const token = m[1]
  if (m[2] === 'go') return { token, action: 'go' }
  if (m[2] === 'pi') return { token, action: 'parkidle' }
  if (m[2] === 'x') return { token, action: 'cancel' }
  if (m[3] !== undefined) return { token, action: 'park', index: Number(m[3]) }
  return { token, action: 'resume', index: Number(m[4]) }
}

/** What a tap may do; the bot implements these over Telegram and the focus tool. */
export type GateEffects = {
  create(h: HeldCreation): Promise<void>
  mark(num: number): Promise<boolean>
  parkIdle(): Promise<boolean>
  resume(item: GateItem, h: HeldCreation): Promise<void>
  notice(text: string): Promise<void>
  cancel(h: HeldCreation): Promise<void>
}

export const EXPIRED_TEXT = '⌛ That prompt has expired. Send /new again, or tap 🆕 New session.'

/**
 * One tap on a gate prompt. A park always goes on to create what was held, even when the
 * focus tool fails to record the park: the gate is soft, and losing the creation over a
 * bookkeeping error would turn it into a block.
 */
export async function runGateTap(tap: GateTap, store: HeldCreations, fx: GateEffects): Promise<'expired' | 'created' | 'resumed' | 'cancelled'> {
  const h = store.take(tap.token)
  if (!h) {
    await fx.notice(EXPIRED_TEXT)
    return 'expired'
  }
  if (tap.action === 'go') {
    await fx.create(h)
    return 'created'
  }
  if (tap.action === 'cancel') {
    await fx.cancel(h)
    return 'cancelled'
  }
  if (tap.action === 'parkidle') {
    const ok = await fx.parkIdle()
    await fx.create(h)
    if (!ok) await fx.notice('⚠️ Could not park the threads you have not touched today; the new session was started anyway. Try `park idle` in 🎯 Focus.')
    return 'created'
  }
  const item = h.view.items[tap.index]
  if (!item) {
    await fx.notice(EXPIRED_TEXT)
    return 'expired'
  }
  if (tap.action === 'resume') {
    await fx.resume(item, h)
    return 'resumed'
  }
  const ok = await fx.mark(item.num)
  await fx.create(h)
  if (!ok) await fx.notice(`⚠️ Could not park #${item.num}; the new session was started anyway. Park it from 🎯 Focus with: park ${item.num}`)
  return 'created'
}
