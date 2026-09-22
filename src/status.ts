/**
 * One live status message per turn.
 *
 * The user's question was "is Claude still busy, or should I ask again?". Telegram's own
 * answer is the typing indicator, which lasts five seconds and carries no detail, so a
 * long autonomous turn looks dead. The status message is the durable version: posted
 * when a turn starts, edited in place with elapsed time and a digest of what happened,
 * kept as the LAST message of the topic, and closed with a one-line summary when the
 * turn ends.
 *
 * Three facts about Telegram shape the design.
 *
 * - An edit sends NO notification, so the answer itself is never an edit of this message:
 *   answers, questions and approvals stay new messages and this one only reports.
 * - Every message, edit and delete counts against one budget of roughly twenty per minute
 *   PER GROUP, and all topics live in one group. So EVERY operation this module performs,
 *   across every topic, draws from one shared budget (`maxOpsPerMinute`, default 12,
 *   leaving the rest for real messages): creates, edits, the two operations of a move,
 *   closings and their retries. What the budget refuses is deferred, never skipped past.
 * - A message cannot be moved. When something is posted below the status it is deleted
 *   and re-posted silently at the bottom, debounced so a burst of posts costs one move,
 *   because a status the reader cannot see answers nothing.
 *
 * Everything here is transport-agnostic: create/edit/remove/type, the same shape on
 * Slack and Discord. The tick is driven from outside so tests control time, and ticks
 * never overlap: a slow API call cannot make the next tick double an edit.
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
  /** A rate limit holds the turn: replaces the spinner line. The note (reset time) is optional. */
  waiting: boolean
  waitNote: string | undefined
  /** The most severe outcome seen so far across the queued turns this status spans. */
  worst: 'ok' | 'limited' | 'error'
}

type Active = TurnState & {
  topicId: string
  messageId?: number
  /** The create is still owed: the budget refused it at begin(); tick() posts it when it can. */
  pendingCreate: boolean
  /** A create or move in progress; edits wait for it. */
  busy: Promise<void> | undefined
  lastText: string
  nextEditAt: number
  lastTypingAt: number
  editsDisabled: boolean
  showItems: boolean
  /** Something was posted below the status; it must move to the bottom. */
  needsMove: boolean
  lastBumpAt: number
}

export type TurnStatusOptions = {
  now?: () => number
  /** Minimum gap between two edits of one message (stretched when many topics are active). */
  editEveryMs?: number
  /** The first edit comes sooner, so the first tool lines appear quickly. */
  firstEditAfterMs?: number
  typingEveryMs?: number
  /** A turn shorter than this with no tool call leaves nothing behind. */
  minKeepMs?: number
  maxChars?: number
  /** Shared across every topic and every operation this module performs, per minute. */
  maxOpsPerMinute?: number
  /** A burst of posts moves the status once, this long after the last post. */
  moveDebounceMs?: number
}

const FRAMES = ['⏳', '⌛']
const RANK = { ok: 0, limited: 1, error: 2 } as const

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
    ? `⏸ Rate limit hit${st.waitNote ? ` · ${st.waitNote}` : ''} · ${fmtElapsed(elapsedMs)}`
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
    outcome === 'ok' ? '✅ Done' : outcome === 'error' ? '⚠️ Ended with an error' : outcome === 'limited' ? `⏸ Rate limit hit${st.waitNote ? ` · ${st.waitNote}` : ''}` : '⏹ Stopped'
  const edits = new Set(st.items.filter(i => i.kind === 'edit').map(i => i.label)).size
  const parts = [icon, fmtElapsed(elapsedMs)]
  if (st.toolCalls) parts.push(plural(st.toolCalls, 'tool call'))
  if (edits) parts.push(plural(edits, 'file edited', 'files edited'))
  return parts.join(' · ')
}

type Closing = { topicId: string; messageId: number; text: string; nextAt: number; attempts: number; inFlight: boolean }
type EditResult = { ok: boolean; retryAfterMs?: number; gone?: boolean }

export class TurnStatus {
  private readonly active = new Map<string, Active>()
  private readonly closing = new Map<number, Closing>()
  /** Timestamps of the operations spent in the last minute, across every topic. */
  private readonly ops: number[] = []
  private ticking = false
  private readonly now: () => number
  private readonly editEveryMs: number
  private readonly firstEditAfterMs: number
  private readonly typingEveryMs: number
  private readonly minKeepMs: number
  private readonly maxChars: number
  private readonly maxOpsPerMinute: number
  private readonly moveDebounceMs: number

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
    this.maxOpsPerMinute = opts.maxOpsPerMinute ?? 12
    this.moveDebounceMs = opts.moveDebounceMs ?? 1_500
  }

  isActive(topicId: string): boolean {
    return this.active.has(topicId)
  }

  activeCount(): number {
    return this.active.size
  }

  /** Summaries still waiting for their edit to land (a 429 on the final edit, or no budget). */
  pendingClosings(): number {
    return this.closing.size
  }

  // ── the shared budget ──────────────────────────────────────────────────────

  /** Reserve `n` operations now, or none: a move needs both its delete and its create. */
  private spend(now: number, n = 1): boolean {
    while (this.ops.length && this.ops[0] <= now - 60_000) this.ops.shift()
    if (this.ops.length + n > this.maxOpsPerMinute) return false
    for (let i = 0; i < n; i++) this.ops.push(now)
    return true
  }

  /** Per-topic edit interval: the configured minimum, stretched so all topics fit the budget. */
  private editInterval(): number {
    return Math.max(this.editEveryMs, Math.ceil((this.active.size * 60_000) / this.maxOpsPerMinute))
  }

  private typingInterval(): number {
    return this.active.size > 3 ? this.typingEveryMs * 2 : this.typingEveryMs
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  /**
   * A turn started (or another message was queued behind a running one). The message is
   * posted now when the budget allows and otherwise owed to the next tick that can pay.
   */
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
      waiting: false,
      waitNote: undefined,
      worst: 'ok',
      messageId: undefined,
      pendingCreate: true,
      busy: undefined,
      lastText: '',
      nextEditAt: now + this.firstEditAfterMs,
      lastTypingAt: 0,
      editsDisabled: false,
      showItems,
      needsMove: false,
      lastBumpAt: 0,
    }
    this.active.set(topicId, a)
    if (this.spend(now)) this.create(a, now)
  }

  private create(a: Active, now: number): void {
    a.pendingCreate = false
    const text = renderStatus(a, now - a.startedAt, { showItems: a.showItems, maxChars: this.maxChars })
    a.busy = this.transport
      .create(a.topicId, text)
      .then(id => {
        a.messageId = id
        a.lastText = text
        if (id === undefined) a.editsDisabled = true
      })
      .catch(() => {
        a.editsDisabled = true
      })
      .finally(() => {
        a.busy = undefined
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
    if (!a) return
    a.waiting = true
    a.waitNote = note
  }

  /**
   * One queued turn ended while others remain. Records how it went (a later success must
   * not summarize the run as done), advances the count, and clears a rate-limit wait: the
   * next turn is running, whatever held the previous one.
   */
  turnEnded(topicId: string, inFlight: number, outcome: 'ok' | 'error' | 'limited'): void {
    const a = this.active.get(topicId)
    if (!a) return
    if (RANK[outcome] > RANK[a.worst]) a.worst = outcome
    a.inFlight = inFlight
    a.waiting = false
    a.waitNote = undefined
  }

  /** Something else was posted in the topic (by the bot OR the user): the status must move below it. */
  bump(topicId: string): void {
    const a = this.active.get(topicId)
    if (!a) return
    a.needsMove = true
    a.lastBumpAt = this.now()
  }

  // ── the tick ───────────────────────────────────────────────────────────────

  /**
   * Drive from a 1 s interval. Serialized: a tick that is still awaiting the API returns
   * the next caller at once, so nothing is edited twice. Order of spending: owed creates
   * (a turn with no status at all), closings (a turn that ended must not read "Working"),
   * moves (a buried status answers nothing), then edits, oldest due first. Typing costs
   * no budget.
   */
  async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      await this.tickInner()
    } finally {
      this.ticking = false
    }
  }

  private async tickInner(): Promise<void> {
    const now = this.now()

    const typingEvery = this.typingInterval()
    for (const a of this.active.values()) {
      if (now - a.lastTypingAt >= typingEvery) {
        a.lastTypingAt = now
        void this.transport.type(a.topicId).catch(() => {})
      }
    }

    for (const a of [...this.active.values()].filter(x => x.pendingCreate)) {
      if (!this.spend(now)) return
      this.create(a, now)
    }

    for (const c of [...this.closing.values()].filter(x => !x.inFlight && now >= x.nextAt)) {
      if (!this.spend(now)) return
      await this.tryClose(c)
    }

    const ready = [...this.active.values()].filter(a => !a.editsDisabled && a.messageId !== undefined && !a.busy && !a.pendingCreate)
    const interval = this.editInterval()

    for (const a of ready.filter(x => x.needsMove && now - x.lastBumpAt >= this.moveDebounceMs)) {
      if (!this.spend(now, 2)) return // a move is a delete AND a create
      await this.move(a, now, interval)
    }
    for (const a of ready.filter(x => !x.needsMove && now >= x.nextEditAt).sort((x, y) => x.nextEditAt - y.nextEditAt)) {
      a.frame++
      const text = renderStatus(a, now - a.startedAt, { showItems: a.showItems, maxChars: this.maxChars })
      if (text === a.lastText) {
        a.nextEditAt = now + interval
        continue
      }
      if (!this.spend(now)) return
      a.nextEditAt = now + interval
      const r = await this.transport.edit(a.topicId, a.messageId as number, text).catch((): EditResult => ({ ok: false }))
      if (r.ok) a.lastText = text
      else if (r.gone) a.editsDisabled = true
      else if (r.retryAfterMs) a.nextEditAt = now + r.retryAfterMs + 500 // exactly what Telegram asked, plus a margin
    }
  }

  /** Delete the buried message and post the current text at the bottom, silently. */
  private async move(a: Active, now: number, interval: number): Promise<void> {
    const old = a.messageId as number
    a.needsMove = false
    a.frame++
    const text = renderStatus(a, now - a.startedAt, { showItems: a.showItems, maxChars: this.maxChars })
    a.busy = (async () => {
      void this.transport.remove(a.topicId, old).catch(() => {})
      const id = await this.transport.create(a.topicId, text).catch(() => undefined)
      if (id === undefined) {
        a.editsDisabled = true // the old one is gone and no new one exists; nothing to edit
        return
      }
      a.messageId = id
      a.lastText = text
      a.nextEditAt = now + interval
    })().finally(() => {
      a.busy = undefined
    })
    await a.busy
  }

  /**
   * The turn ended: a one-line summary, or nothing for a short quiet turn. If content was
   * posted below the status since its last move, the summary is posted at the bottom
   * instead of edited in place, so the last message of the topic is the verdict. The
   * closing is queued and paid for from the budget like everything else, and retried
   * from tick() when Telegram answers 429, so a status never stays on "Working".
   */
  async finish(topicId: string, outcome: Outcome): Promise<void> {
    const a = this.active.get(topicId)
    if (!a) return
    this.active.delete(topicId)
    if (a.busy) await a.busy.catch(() => {})
    if (a.messageId === undefined) return // never posted (budget) or could not be: nothing to close
    const now = this.now()
    const elapsed = now - a.startedAt
    // A later turn's success does not erase an earlier turn's failure in the same run.
    const final: Outcome = outcome === 'stopped' ? 'stopped' : RANK[outcome] >= RANK[a.worst] ? outcome : a.worst
    if (final === 'ok' && elapsed < this.minKeepMs && a.toolCalls === 0) {
      // Removing a short quiet turn's message costs one operation; a refused budget here
      // just leaves a "Working · 0:03" line, which is harmless and self-explanatory.
      if (this.spend(now)) await this.transport.remove(topicId, a.messageId).catch(() => {})
      return
    }
    if (a.editsDisabled) return
    const text = renderSummary(a, elapsed, final)
    if (a.needsMove) {
      if (this.spend(now, 2)) {
        void this.transport.remove(topicId, a.messageId).catch(() => {})
        await this.transport.create(topicId, text).catch(() => undefined)
        return
      }
      // No budget to move: edit in place instead, below via the closing queue.
    }
    const c: Closing = { topicId, messageId: a.messageId, text, nextAt: now, attempts: 0, inFlight: false }
    this.closing.set(c.messageId, c)
    if (this.spend(now)) await this.tryClose(c)
  }

  /** One attempt at a queued closing; budget must have been reserved by the caller. */
  private async tryClose(c: Closing): Promise<void> {
    if (!this.closing.has(c.messageId)) return // dropped meanwhile
    c.inFlight = true
    c.attempts++
    const r = await this.transport.edit(c.topicId, c.messageId, c.text).catch((): EditResult => ({ ok: false }))
    c.inFlight = false
    if (r.ok || r.gone || c.attempts >= 10) {
      this.closing.delete(c.messageId)
      return
    }
    c.nextAt = this.now() + (r.retryAfterMs ?? 5_000) + 500
  }

  /** The topic is gone (deleted/wiped): drop the message, forget the turn and any pending closing. */
  async drop(topicId: string): Promise<void> {
    for (const [id, c] of [...this.closing.entries()]) if (c.topicId === topicId) this.closing.delete(id)
    const a = this.active.get(topicId)
    if (!a) return
    this.active.delete(topicId)
    if (a.busy) await a.busy.catch(() => {})
    if (a.messageId !== undefined) await this.transport.remove(topicId, a.messageId).catch(() => {})
  }
}
