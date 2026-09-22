/**
 * One live status message per turn.
 *
 * The user's question was "is Claude still busy, or should I ask again?". Telegram's own
 * answer is the typing indicator, which lasts five seconds and carries no detail, so a
 * long autonomous turn looks dead. The status message is the durable version: posted
 * when a turn starts, edited in place with elapsed time and a digest of what happened,
 * and closed with a one-line summary when the turn ends.
 *
 * Two facts about Telegram shape the design. An edit sends NO notification, so the
 * answer itself is never an edit of this message: answers, questions and approvals stay
 * new messages and this one only reports progress. And edits are rate-limited, so this
 * module edits at most once per `editEveryMs` per topic, only when the text changed, and
 * backs off for exactly the `retry_after` Telegram asks for on a 429.
 *
 * Everything here is transport-agnostic: the transport implements create/edit/remove/
 * type, which is the same three-call shape on Slack (postMessage/update/delete) and
 * Discord. The tick is driven from outside so tests control time.
 */
import { digest, type FeedItem } from './feed'

export interface StatusTransport {
  /** Post the message; return its id, or undefined when it could not be posted. */
  create(topicId: string, text: string): Promise<number | undefined>
  /** `gone` = the message no longer exists (deleted by the user); stop editing it. */
  edit(topicId: string, messageId: number, text: string): Promise<{ ok: boolean; retryAfterMs?: number; gone?: boolean }>
  remove(topicId: string, messageId: number): Promise<void>
  type(topicId: string): Promise<void>
}

export type TurnState = {
  startedAt: number
  items: FeedItem[]
  toolCalls: number
  /** Turns in flight: 1 = the one running; more = queued behind it. */
  inFlight: number
  frame: number
  /** Set while a rate limit holds the turn: replaces the spinner line. */
  waiting: string | undefined
}

type Active = TurnState & {
  topicId: string
  messageId?: number
  creating: Promise<void> | undefined
  lastText: string
  lastEditAt: number
  nextEditAt: number
  lastTypingAt: number
  editsDisabled: boolean
  showItems: boolean
}

export type TurnStatusOptions = {
  now?: () => number
  /** Minimum gap between two edits of one message. */
  editEveryMs?: number
  /** The first edit comes sooner, so the first tool lines appear quickly. */
  firstEditAfterMs?: number
  typingEveryMs?: number
  /** A turn shorter than this with no tool call leaves nothing behind. */
  minKeepMs?: number
  maxChars?: number
}

const FRAMES = ['⏳', '⌛']

export function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`
}

function plural(n: number, one: string, many = one + 's'): string {
  return `${n} ${n === 1 ? one : many}`
}

/** The live text. Pure, capped to one Telegram message. */
export function renderStatus(st: TurnState, elapsedMs: number, opts: { showItems?: boolean; maxChars?: number } = {}): string {
  const head = st.waiting
    ? `⏸ Rate limit hit · ${st.waiting} · ${fmtElapsed(elapsedMs)}`
    : `${FRAMES[st.frame % FRAMES.length]} Working · ${fmtElapsed(elapsedMs)}` +
      (st.toolCalls ? ` · ${plural(st.toolCalls, 'tool call')}` : '') +
      (st.inFlight > 1 ? ` · ${plural(st.inFlight - 1, 'message')} queued` : '')
  const lines = opts.showItems === false ? [] : digest(st.items)
  const max = opts.maxChars ?? 3500
  let text = [head, ...lines].join('\n')
  if (text.length > max) text = text.slice(0, max - 1) + '…'
  return text
}

export type Outcome = 'ok' | 'error' | 'stopped' | 'limited'

/** The closing line. */
export function renderSummary(st: TurnState, elapsedMs: number, outcome: Outcome): string {
  const icon =
    outcome === 'ok' ? '✅ Done' : outcome === 'error' ? '⚠️ Ended with an error' : outcome === 'limited' ? `⏸ Rate limit hit${st.waiting ? ` · ${st.waiting}` : ''}` : '⏹ Stopped'
  const edits = new Set(st.items.filter(i => i.kind === 'edit').map(i => i.label)).size
  const parts = [icon, fmtElapsed(elapsedMs)]
  if (st.toolCalls) parts.push(plural(st.toolCalls, 'tool call'))
  if (edits) parts.push(plural(edits, 'file edited', 'files edited'))
  return parts.join(' · ')
}

export class TurnStatus {
  private readonly active = new Map<string, Active>()
  private readonly now: () => number
  private readonly editEveryMs: number
  private readonly firstEditAfterMs: number
  private readonly typingEveryMs: number
  private readonly minKeepMs: number
  private readonly maxChars: number

  constructor(
    private readonly transport: StatusTransport,
    opts: TurnStatusOptions = {},
  ) {
    this.now = opts.now ?? (() => Date.now())
    this.editEveryMs = opts.editEveryMs ?? 12_000
    this.firstEditAfterMs = opts.firstEditAfterMs ?? 3_000
    this.typingEveryMs = opts.typingEveryMs ?? 4_500
    this.minKeepMs = opts.minKeepMs ?? 5_000
    this.maxChars = opts.maxChars ?? 3500
  }

  isActive(topicId: string): boolean {
    return this.active.has(topicId)
  }

  /** A turn started (or another message was queued behind a running one). */
  begin(topicId: string, inFlight: number, showItems = true): void {
    const cur = this.active.get(topicId)
    if (cur) {
      cur.inFlight = Math.max(cur.inFlight, inFlight)
      return
    }
    const now = this.now()
    const a: Active = {
      topicId,
      startedAt: now,
      items: [],
      toolCalls: 0,
      inFlight,
      frame: 0,
      waiting: undefined,
      messageId: undefined,
      creating: undefined,
      lastText: '',
      lastEditAt: now,
      nextEditAt: now + this.firstEditAfterMs,
      lastTypingAt: 0,
      editsDisabled: false,
      showItems,
    }
    this.active.set(topicId, a)
    const text = renderStatus(a, 0, { showItems, maxChars: this.maxChars })
    a.lastText = text
    a.creating = this.transport
      .create(topicId, text)
      .then(id => {
        a.messageId = id
        if (id === undefined) a.editsDisabled = true
      })
      .catch(() => {
        a.editsDisabled = true
      })
      .finally(() => {
        a.creating = undefined
      })
  }

  addItems(topicId: string, items: FeedItem[]): void {
    const a = this.active.get(topicId)
    if (!a || !items.length) return
    a.items.push(...items)
    a.toolCalls += items.filter(i => i.kind !== 'task').length
  }

  setInFlight(topicId: string, inFlight: number): void {
    const a = this.active.get(topicId)
    if (a) a.inFlight = inFlight
  }

  waiting(topicId: string, note: string | undefined): void {
    const a = this.active.get(topicId)
    if (a) a.waiting = note
  }

  /** Drive from a 1 s interval: typing while in flight, an edit when due and changed. */
  async tick(): Promise<void> {
    const now = this.now()
    for (const a of [...this.active.values()]) {
      if (now - a.lastTypingAt >= this.typingEveryMs) {
        a.lastTypingAt = now
        void this.transport.type(a.topicId).catch(() => {})
      }
      if (a.editsDisabled || a.messageId === undefined || now < a.nextEditAt) continue
      a.frame++
      const text = renderStatus(a, now - a.startedAt, { showItems: a.showItems, maxChars: this.maxChars })
      if (text === a.lastText) {
        a.nextEditAt = now + this.editEveryMs
        continue
      }
      a.nextEditAt = now + this.editEveryMs // set before the await so a slow edit cannot double-fire
      const r = await this.transport.edit(a.topicId, a.messageId, text).catch(() => ({ ok: false }) as { ok: boolean; retryAfterMs?: number; gone?: boolean })
      if (r.ok) {
        a.lastText = text
        a.lastEditAt = now
      } else if (r.gone) {
        a.editsDisabled = true
      } else if (r.retryAfterMs) {
        a.nextEditAt = now + r.retryAfterMs + 500 // exactly what Telegram asked, plus a margin
      }
    }
  }

  /** The turn ended: a one-line summary, or nothing for a short quiet turn. */
  async finish(topicId: string, outcome: Outcome): Promise<void> {
    const a = this.active.get(topicId)
    if (!a) return
    this.active.delete(topicId)
    if (a.creating) await a.creating.catch(() => {})
    if (a.messageId === undefined) return
    const elapsed = this.now() - a.startedAt
    if (outcome === 'ok' && elapsed < this.minKeepMs && a.toolCalls === 0) {
      await this.transport.remove(topicId, a.messageId).catch(() => {})
      return
    }
    if (a.editsDisabled) return
    await this.transport.edit(topicId, a.messageId, renderSummary(a, elapsed, outcome)).catch(() => {})
  }

  /** The topic is gone (deleted/wiped): drop the message and forget the turn. */
  async drop(topicId: string): Promise<void> {
    const a = this.active.get(topicId)
    if (!a) return
    this.active.delete(topicId)
    if (a.creating) await a.creating.catch(() => {})
    if (a.messageId !== undefined) await this.transport.remove(topicId, a.messageId).catch(() => {})
  }
}
