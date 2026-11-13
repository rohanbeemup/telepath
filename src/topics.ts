/**
 * Live sessions per topic: opening and resuming, the live-session cap, idle eviction,
 * the rate-limit auto-resume, and the rotation watch. Everything Telegram- or
 * SDK-specific is injected, so this module is exercised in tests with a fake backend
 * and a recording notifier.
 */
import type { CanUseTool, HookCallbackMatcher, HookEvent } from '@anthropic-ai/claude-agent-sdk'
import { interpret, newPumpState, type Event } from './interpret'
import { HANDOFF_MARKER, parseHandoff, WRAP_UP_PROMPT } from './handoff'
import type { Effort } from './models'
import { effortFor, type Catalog } from './models'
import type { Binding, Store } from './state'
import type { Logger, Metrics } from './log'

export type SessionExtras = {
  canUseTool: CanUseTool
  hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>>
}

export type OpenOptions = {
  topicId: string
  cwd: string
  model: string
  effort?: Effort
  resume?: string
  env: Record<string, string | undefined>
  /** What is left of the topic's budget for this stretch; unset when there is no budget. */
  budgetUsd?: number
} & SessionExtras

export interface LiveSession {
  send(text: string, opts?: { priority?: 'now' | 'next' }): void
  stream(): AsyncIterable<unknown>
  close(): void
}

/**
 * A wrap-up in progress. Measured against the CLI: the instruction always gets a turn of
 * its own, so two results follow the request (the preempted or finished turn's, then the
 * wrap-up's); the hand-off, when written, is in the text before the second.
 */
type Wrap = { when: 'now' | 'after-turn'; handoff: string | undefined; resultsSeen: number }

export interface SessionBackend {
  open(opts: OpenOptions): LiveSession
}

export type Live = {
  session: LiveSession
  topicId: string
  model: string
  cwd: string
  lastActive: number
  /** When the session last produced a stream message; what "stuck" is measured from, since a member's messages into a hung topic must not keep its slot. */
  lastOutput: number
  /**
   * A turn is running: set when a message is sent into an idle session or the stream
   * shows a turn beginning (`system/init`, or output with no turn known), cleared by the
   * turn's `result`. Measured: messages sent while a turn runs are folded INTO that turn
   * and answered by its one result, so results are not counted against sends. A count
   * that did was off by one per folded message and read "9 messages queued" over a
   * session that had answered everything.
   */
  running: boolean
  /** Messages sent since the running turn began; the CLI folds them into it. Shown as "queued". */
  queued: number
  wrap?: Wrap
}

export function isBusy(l: Live): boolean {
  return l.running
}

/** A turn with no result for this long, in a shared forum, is stuck: it may be paused for a new topic. */
export const DEFAULT_STUCK_TURN_MS = 10 * 60_000
/** A stored hand-off is at most one Telegram message long. */
const HANDOFF_MAX = 4000
/** Said when a running turn is ended as stuck: the turn and what was sent during it are gone, the transcript before it stays. */
const STUCK_PAUSED = '💤 Paused: no output for a while. The unfinished turn, and anything sent during it, is lost; send it again to continue — the earlier context is kept.'

export type Rotator = {
  enabled(): boolean
  active(): string | undefined
  handOff(msg: unknown): void
  waitForRotation(before: string | undefined): Promise<string | undefined>
}

export type TopicDeps = {
  store: Store
  catalog: Catalog
  idleMinutes: number
  maxLiveSessions: number
  backend: SessionBackend
  /** The environment handed to every session, before this module's own filtering. */
  baseEnv: () => Record<string, string | undefined>
  outboxDir: (topicId: string) => string
  extras: (topicId: string) => SessionExtras
  /** Delivery of everything the user reads; the bot implements it. */
  say: (topicId: string, text: string) => Promise<void>
  onEvent: (topicId: string, ev: Event) => Promise<void>
  rotator: Rotator
  log: Logger
  metrics: Metrics
  now?: () => number
  /** Buffer past a rate-limit reset before nudging; small in tests. */
  resumeBufferMs?: number
  /**
   * Prepend the file-delivery contract to a session's first message (default). Off for
   * sessions with no file tools (a profile): told where to save files, they cannot.
   */
  primeContract?: boolean
  /**
   * A per-topic budget in USD, across idle stretches. The SDK's own `maxBudgetUsd` is per
   * `query()`, so on its own every idle eviction and resume hands a topic a fresh budget.
   */
  budgetUsd?: number
  /**
   * Every session runs a profile: only a binding made under it may resume its session. A
   * binding from before the profile would hand a full session's transcript to the topic.
   */
  profileSessions?: boolean
  /**
   * The forum is shared (team mode): a binding's `closed` is honoured (no session opens there
   * until an admin reopens it), and a colleague's running turn is never paused for a new
   * topic unless it has run past stuckTurnMs. Elsewhere, as before: `closed` is written but
   * ignored, and the longest-idle session, running or not, is paused for the new topic.
   */
  shared?: boolean
  /** In a shared forum, a turn with no result for this long is stuck and may be paused for a new topic. */
  stuckTurnMs?: number
  /** The bot's one rule for replies a member can trigger at will (topic and kind, and the sender's allowance): true when a notice is muted now, counted there. */
  replyMuted: (topicId: string, kind: string, senderId?: string) => boolean
  /** Whether a session's transcript is still on disk (undefined: could not look); without a definite no, a failed resume is never read as a lost transcript. */
  transcriptExists?: (sessionId: string) => boolean | undefined
}

export const CONTINUE_AFTER_LIMIT =
  'The rate limit that interrupted you has reset. Continue with the task you were working on. ' +
  'If you were waiting on a background task or command, check its result now (the completion notification may have been lost) and proceed.'
export const CONTINUE_AFTER_ROTATION =
  'The rate limit that interrupted you was resolved by switching accounts. Continue with the task you were working on. ' +
  'If you were waiting on a background task or command, check its result now (the completion notification may have been lost) and proceed.'

/** The file-delivery contract, stated once to each session. */
export function outboxContract(dir: string): string {
  return (
    `You are operated remotely over Telegram; the user cannot see your filesystem. ` +
    `To show the user an image or file (screenshot, chart, diagram, PDF, export), copy or save it into this directory:\n` +
    `${dir}\n` +
    `Anything placed there is delivered to the user in this chat automatically: images as photos, videos (mp4/mov/webm) as playable videos, GIFs as animations, audio (mp3/m4a/ogg) as audio tracks, and other files as documents. ` +
    `When the user asks to see something visual, deliver it this way; don't only describe it.`
  )
}

export class TopicManager {
  readonly live = new Map<string, Live>()
  private readonly primed = new Set<string>()
  private readonly resumeTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /** Bumped by every user action on a topic; a pending rotation watch compares against it. */
  private readonly takeoverGen = new Map<string, number>()
  private readonly now: () => number

  constructor(private readonly d: TopicDeps) {
    this.now = d.now ?? (() => Date.now())
  }

  isLive(topicId: string): boolean {
    return this.live.has(topicId)
  }

  /** Every user action on a topic: cancels a pending nudge and invalidates rotation watches. */
  userTookOver(topicId: string): void {
    this.takeoverGen.set(topicId, (this.takeoverGen.get(topicId) ?? 0) + 1)
    const t = this.resumeTimers.get(topicId)
    if (t) {
      clearTimeout(t)
      this.resumeTimers.delete(topicId)
    }
  }

  forget(topicId: string): void {
    this.primed.delete(topicId)
    this.takeoverGen.delete(topicId)
  }

  closeLive(topicId: string, why: string): void {
    const l = this.live.get(topicId)
    if (!l) return
    try {
      l.session.close()
    } catch {}
    this.live.delete(topicId)
    this.d.metrics.inc('sessions_closed')
    this.d.log.info('session.close', { topic: topicId, why })
  }

  closeAll(why: string): void {
    for (const id of [...this.live.keys()]) this.closeLive(id, why)
  }

  /**
   * In a shared forum, a running turn that has produced nothing past stuckTurnMs. Measured
   * from the session's last stream message (the pump keeps lastOutput), so a long turn
   * still producing is never stuck (thirteenth review), and a member typing "hello?" into
   * a hung topic does not keep its slot (fourteenth review).
   */
  private stuck(l: Live, now = this.now()): boolean {
    // A turn parked on a rate limit with a resume scheduled is waiting, not hung (nineteenth review).
    if (this.resumeTimers.has(l.topicId)) return false
    return !!this.d.shared && isBusy(l) && now - l.lastOutput >= (this.d.stuckTurnMs ?? DEFAULT_STUCK_TURN_MS)
  }

  /**
   * Whether a live session may be paused to free a slot. Where the forum is one person's,
   * any session: the longest-idle one goes, running or not, as before. In a shared forum
   * only an idle one, or a stuck turn: pausing a colleague's running turn would let one
   * member kill it by opening topics (security review), while a turn that never ends must
   * not hold its slot forever (twelfth review).
   */
  private pausable(l: Live): boolean {
    // A turn parked on a rate limit holds no API call: pausing it loses nothing (its resume
    // opens a fresh stretch), so it must not hold a slot for hours (twenty-third review).
    return !this.d.shared || !isBusy(l) || this.stuck(l) || this.resumeTimers.has(l.topicId)
  }

  /**
   * Frees a slot for a new session by pausing the longest-idle pausable one. openRefusal()
   * refuses the open while nothing is pausable, so a pause is always found here when needed.
   */
  private enforceCap(): void {
    while (this.live.size >= this.d.maxLiveSessions) {
      let oldest: Live | undefined
      for (const l of this.live.values()) if (this.pausable(l) && (!oldest || l.lastActive < oldest.lastActive)) oldest = l
      if (!oldest) break
      // Said on the paused topic, which in a shared forum is usually a colleague's: on the reply
      // rule, so a member alternating between their own topics cannot post there at will.
      if (!this.d.replyMuted(oldest.topicId, 'paused')) void this.d.say(oldest.topicId, this.stuck(oldest) ? STUCK_PAUSED : `💤 Paused to free a slot (max ${this.d.maxLiveSessions} live sessions). Send a message here to resume — your context is kept.`)
      this.d.metrics.inc('sessions_evicted_cap')
      // A parked session's scheduled resume goes with it: the notice said a message resumes it, and
      // the timer would otherwise reopen it on its own and pause the newcomer (twenty-fourth review).
      this.userTookOver(oldest.topicId)
      this.closeLive(oldest.topicId, 'evicted (session cap)')
    }
  }

  /**
   * Why no session may open for this topic now, or undefined when one may: closed by an
   * admin (honoured in a shared forum), its budget spent, or every slot held by a running
   * turn that may not be paused. Read by sendToTopic for its notice and by ensureLive, so
   * the two cannot disagree.
   */
  openRefusal(topicId: string): 'closed' | 'budget' | 'busy' | undefined {
    const b = this.d.store.registry[topicId]
    if (!b) return undefined
    if (b.closed) return 'closed' // written in team mode, cleared at boot outside it; ♻️ Reopen clears it
    const left = this.remainingBudget(b)
    if (left !== undefined && left <= 0) return 'budget'
    if (!this.live.has(topicId) && this.live.size >= this.d.maxLiveSessions && ![...this.live.values()].some(l => this.pausable(l))) return 'busy'
    return undefined
  }

  /**
   * A binding made on the other side of the profile line becomes this side's: its session id
   * goes, in either direction, since a transcript is not the other context's to resume (a full
   * session's tool results, files and questions are not a forum's to show; a forum's transcript,
   * with whatever a member left in it, is not to run under the operator's full toolset), and
   * with it the hand-off (a repo path, a branch, a next command, which ▶️ Resume would feed
   * across), the approval mode, and the old transcript's total as a baseline. True when
   * something changed. Run over the whole registry at boot, and here for any binding added
   * since, so no reader sees the old values (twenty-second review: the reverse direction).
   */
  private adopt(topicId: string, b: Binding): boolean {
    const underProfile = !!this.d.profileSessions
    if (!!b.profile === underProfile) return false
    if (b.sessionId) this.d.log.info('session.resume_dropped', { topic: topicId, sessionId: b.sessionId, why: underProfile ? 'binding predates the profile' : 'binding was made under a profile' })
    b.sessionId = undefined
    b.profile = underProfile
    delete b.handoff
    b.auto = false
    if (this.d.budgetUsd !== undefined) b.reportedUsd = 0
    return true
  }

  /**
   * Every binding from the other side of the profile line, adopted at once (boot); and, where
   * the forum is one person's, every `closed` flag a team-mode run left behind, cleared, so the
   * flag is honoured wherever it is read without a mode check (twenty-second review).
   */
  adoptAll(): void {
    let changed = false
    for (const [topicId, b] of Object.entries(this.d.store.registry)) {
      if (this.adopt(topicId, b)) changed = true
      if (!this.d.shared && b.closed) {
        delete b.closed
        changed = true
      }
    }
    if (changed) this.d.store.saveRegistry()
  }

  /** The topic's live session, opened if need be; `refusalChecked` when the caller asked openRefusal() just now, so the live map is walked once. */
  ensureLive(topicId: string, refusalChecked = false): Live | undefined {
    const existing = this.live.get(topicId)
    if (existing) return existing
    const b = this.d.store.registry[topicId]
    if (!b) return undefined
    if (!refusalChecked && this.openRefusal(topicId)) return undefined
    // A stretch gets what is left of the topic's budget, so it cannot overshoot the cap by
    // a whole fresh budget. This is consistent with the pump's accounting, not at odds with
    // it: the SDK's `maxBudgetUsd` counts only the spend since this query() started (the CLI
    // subtracts the restored cost), while `total_cost_usd` in results carries the transcript's
    // cumulative total (sdk.d.ts, Options.maxBudgetUsd). Three review rounds read the two as
    // one number; they are not.
    const budgetUsd = this.remainingBudget(b)
    this.enforceCap()
    // Child sessions must not see the bot token: a prompt-injected session could read
    // it from the environment and exfiltrate it. Nothing else of ours leaks either.
    const env: Record<string, string | undefined> = { ...this.d.baseEnv(), TELEPATH_OUTBOX: this.d.outboxDir(topicId) }
    delete env.TELEGRAM_BOT_TOKEN
    delete env.CLAUDE_CODE_EFFORT_LEVEL // effort is an option now; an inherited value would override it
    // Under a profile only a binding made under it resumes its session; another binding's
    // transcript (a full session's tool results, files, questions) is not this topic's to show.
    if (this.adopt(topicId, b)) this.d.store.saveRegistry()
    const resume = b.sessionId
    const session = this.d.backend.open({
      topicId,
      cwd: b.cwd,
      model: b.model,
      effort: effortFor(this.d.catalog, b),
      resume,
      env,
      budgetUsd,
      ...this.d.extras(topicId),
    })
    const l: Live = { session, topicId, model: b.model, cwd: b.cwd, lastActive: this.now(), lastOutput: this.now(), running: false, queued: 0 }
    this.live.set(topicId, l)
    this.d.metrics.inc('sessions_opened')
    this.d.log.info('session.open', { topic: topicId, model: b.model, effort: effortFor(this.d.catalog, b) ?? null, resume: resume ?? null })
    void this.pump(l)
    return l
  }

  /** What is left of the topic's budget; undefined when the install has none. */
  private remainingBudget(b: Binding): number | undefined {
    return this.d.budgetUsd === undefined ? undefined : this.d.budgetUsd - (b.spentUsd ?? 0)
  }

  /**
   * A user message into the topic's session, or a nudge (`quiet`: the rate-limit or
   * rotation continuation), which posts no refusal into a topic nobody wrote in.
   */
  async sendToTopic(topicId: string, text: string, opts: { takeover?: boolean; quiet?: boolean; senderId?: string } = {}): Promise<boolean> {
    if (opts.takeover !== false) this.userTookOver(topicId)
    const first = this.openFor(topicId)
    if (!first) return false
    if ('refused' in first) return this.refused(topicId, first.refused, opts)
    let l = first
    l.lastActive = this.now()
    // A new turn's silence counts from its send, not from the last turn's end: a session idle
    // past the stuck bound would otherwise be stuck before its first output (Codex hook).
    if (!l.running) l.lastOutput = this.now()
    let payload = text
    if (!this.primed.has(topicId)) {
      this.primed.add(topicId)
      if (this.d.primeContract !== false) payload = `<telepath>\n${outboxContract(this.d.outboxDir(topicId))}\n</telepath>\n\n${text}`
    }
    try {
      l.session.send(payload)
    } catch (e) {
      // A stale handle slipped through: evict and open once more, under the same refusals
      // (the slot may be gone meanwhile), said the same way.
      this.d.log.warn('session.send_failed', { topic: topicId, error: e })
      this.live.delete(topicId)
      const again = this.openFor(topicId)
      if (!again) return false
      if ('refused' in again) return this.refused(topicId, again.refused, opts)
      l = again
      l.session.send(payload)
    }
    this.d.metrics.inc('messages_in')
    // Into an idle session this starts a turn (the stream's init confirms it shortly);
    // into a running one it joins that turn and is reported as queued until its result.
    if (l.running) l.queued++
    else {
      l.running = true
      l.queued = 0
    }
    void this.d.onEvent(topicId, { kind: 'turn', phase: 'start', inFlight: 1 + l.queued })
    return true
  }

  /**
   * The stream shows a turn beginning: from init, or from output when no turn was known.
   * An init that only confirms a turn a send already started changes nothing: a message
   * sent between that send and the init is still unanswered and stays counted.
   */
  private turnBegan(l: Live): void {
    if (l.running) return
    l.running = true
    l.queued = 0
    void this.d.onEvent(l.topicId, { kind: 'turn', phase: 'start', inFlight: 1 })
  }

  /**
   * Wrap up the running turn: finish the current step (or the current turn), write a
   * hand-off, stop. The instruction jumps ahead of everything the user sent since the
   * turn began; those messages are already with the session (the CLI folds them into
   * the running or the next turn), so there is nothing to drop and the hand-off covers them.
   */
  wrapUp(topicId: string, opts: { when: 'now' | 'after-turn' }): boolean {
    const l = this.live.get(topicId)
    if (!l || !isBusy(l) || l.wrap) return false
    // A wrap-up is the user taking over: a pending rate-limit nudge or rotation watch
    // would otherwise restart the work after the hand-off.
    this.userTookOver(topicId)
    l.wrap = { when: opts.when, handoff: undefined, resultsSeen: 0 }
    l.session.send(WRAP_UP_PROMPT, { priority: opts.when === 'now' ? 'now' : 'next' })
    this.d.metrics.inc('wrap_ups')
    this.d.log.info('session.wrap_up', { topic: topicId, when: opts.when, queued: l.queued })
    return true
  }

  /** Idle eviction: a session with no turn in flight and nothing said for idleMinutes. */
  evictIdle(): void {
    const now = this.now()
    const cutoff = now - this.d.idleMinutes * 60_000
    for (const l of [...this.live.values()]) {
      if (!isBusy(l) && l.lastActive < cutoff) {
        this.d.metrics.inc('sessions_evicted_idle')
        this.closeLive(l.topicId, 'idle')
      } else if (this.stuck(l, now)) {
        // A hung process in a shared forum is not kept until cap pressure finds it.
        void this.d.say(l.topicId, STUCK_PAUSED)
        this.d.metrics.inc('sessions_evicted_stuck')
        this.closeLive(l.topicId, 'stuck')
      }
    }
  }

  /** Whether a rate-limit resume is scheduled for the topic. */
  scheduledResume(topicId: string): boolean {
    return this.resumeTimers.has(topicId)
  }

  private scheduleResume(topicId: string, resetsAt?: number): string | undefined {
    if (!resetsAt) return undefined
    const at = resetsAt > 1e12 ? resetsAt : resetsAt * 1000
    const delay = at - this.now() + (this.d.resumeBufferMs ?? 60_000)
    if (delay <= 0 || delay > 12 * 3600_000) return undefined
    const old = this.resumeTimers.get(topicId)
    if (old) clearTimeout(old)
    this.resumeTimers.set(
      topicId,
      setTimeout(() => {
        this.resumeTimers.delete(topicId)
        if (!this.d.store.registry[topicId]) return
        this.d.metrics.inc('rate_limit_resumes')
        void this.resumeWith(topicId, CONTINUE_AFTER_LIMIT, '▶️ Rate limit reset — resuming automatically.')
      }, delay),
    )
    const dt = new Date(at)
    return `${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`
  }

  private async resumeAfterRotation(topicId: string, before: string | undefined): Promise<void> {
    const gen = this.takeoverGen.get(topicId) ?? 0
    const now = await this.d.rotator.waitForRotation(before)
    if (!now) return
    if (!this.d.store.registry[topicId]) return
    if ((this.takeoverGen.get(topicId) ?? 0) !== gen) return // the user took over meanwhile
    this.userTookOver(topicId) // clears the reset nudge; the rotation supersedes it
    this.closeLive(topicId, `account rotated ${before ?? '?'} -> ${now}`)
    this.d.metrics.inc('rotations_resumed')
    // The account's label is the operator's, not a shared forum's (security read).
    await this.resumeWith(topicId, CONTINUE_AFTER_ROTATION, this.d.shared ? '🔁 Continuing now.' : `🔁 Account rotated to ${now} — continuing now.`)
  }

  /**
   * A continuation of the bot's own (a quiet nudge), announced once it is in, so a topic
   * that cannot take it is not told "resuming" and then left hanging. A closed topic never
   * gets here (closing takes the topic over, which cancels both continuations); a budget
   * spent meanwhile can, and is said instead.
   */
  private async resumeWith(topicId: string, nudge: string, announce: string): Promise<void> {
    if (await this.sendToTopic(topicId, nudge, { takeover: false, quiet: true })) {
      await this.d.say(topicId, announce)
      return
    }
    const why = this.openRefusal(topicId)
    if (why === 'budget') await this.d.say(topicId, '💸 Not resumed: this topic has used its budget. Open a new topic for the next question.')
    else if (why === 'busy') await this.d.say(topicId, '⏳ Not resumed: every session slot is busy. Send a message here when one is free.')
  }

  /**
   * A refused message is counted every time and answered at most once a minute per topic:
   * a member's flood of refused messages is otherwise the bot's flood (security read).
   */
  /**
   * The topic's live session for a message, the refusal when the topic cannot take one now,
   * or undefined when nothing is bound. Synchronous, so nothing can run between a session's
   * opening and its first send: an await there let cap pressure from another topic pause the
   * new, still idle session before it was used (Codex hook).
   */
  private openFor(topicId: string): Live | { refused: 'closed' | 'budget' | 'busy' } | undefined {
    // The refusal first, before the live session is found: a topic still live but over its budget
    // (or closed, or full) is refused, not written into. Asked once; ensureLive is told.
    const why = this.openRefusal(topicId)
    if (why) return { refused: why }
    return this.ensureLive(topicId, true)
  }

  /** A refused send: said, unless the message is a quiet nudge, which reports undelivered. */
  private async refused(topicId: string, why: 'closed' | 'budget' | 'busy', opts: { quiet?: boolean; senderId?: string }): Promise<boolean> {
    if (opts.quiet) return false
    await this.refuse(topicId, why, opts.senderId)
    return true
  }

  private async refuse(topicId: string, why: 'closed' | 'budget' | 'busy', senderId?: string): Promise<void> {
    this.d.metrics.inc(`${why}_refusals`)
    // The bot's one rule for replies a member can trigger: topic and kind, and the sender's allowance.
    if (!this.d.replyMuted(topicId, why, senderId)) await this.d.say(topicId, this.refusalNotice(why))
  }

  private refusalNotice(why: 'closed' | 'budget' | 'busy'): string {
    switch (why) {
      case 'closed':
        return '🔒 An admin closed this topic. An admin can reopen it from the pinned panel.'
      case 'budget':
        return `💸 This topic has used its budget ($${(this.d.budgetUsd ?? 0).toFixed(2)}). Open a new topic for the next question; an admin can delete this one.`
      case 'busy':
        return `⏳ Every session slot is busy (max ${this.d.maxLiveSessions} live sessions, all running a turn). Send your message again in a moment.`
    }
  }

  private async pump(l: Live): Promise<void> {
    const topicId = l.topicId
    const st = newPumpState(this.d.store.registry[topicId]?.sessionId)
    const resumedId = this.d.store.registry[topicId]?.sessionId
    let answered = false
    try {
      for await (const msg of l.session.stream()) {
        // A turn still producing is never stuck. lastActive stays what it is on main (a message or
        // a result): idle eviction never reads it for a running session, and the cap's victim
        // order in a one-person forum is main's.
        l.lastOutput = this.now()
        const b = this.d.store.registry[topicId]
        // Output with no turn known (a turn the CLI began on its own after a preemption,
        // or an init this pump missed) is a running turn: count it, or eviction and the
        // status would both be wrong about it.
        if ((msg as { type?: unknown })?.type === 'assistant' && !l.running) this.turnBegan(l)
        for (const ev of interpret(msg, st)) {
          switch (ev.kind) {
            case 'init':
              this.turnBegan(l)
              break
            case 'sessionId': {
              if (b && !b.sessionId) {
                b.sessionId = ev.id
                this.d.store.saveRegistry()
                this.d.log.info('session.id', { topic: topicId, sessionId: ev.id })
                await this.d.onEvent(topicId, ev)
              }
              break
            }
            case 'limitRelay':
              this.d.rotator.handOff(ev.raw)
              break
            case 'rateLimitHit': {
              this.d.metrics.inc('rate_limit_rejections')
              // Baseline BEFORE the hand-off: interpret() orders the hit ahead of the
              // relay for exactly this read, so the rotator has not been spawned yet.
              const activeBefore = this.d.rotator.active()
              const rot = this.d.rotator.enabled()
              const until = this.scheduleResume(topicId, ev.resetsAt)
              const rotating = rot ? (this.d.shared ? ' I may continue sooner on my own.' : ' If the account rotator switches accounts I continue right away.') : ''
              // Under a profile there is no model to switch to: the offer would name a button that is not there.
              const lighter = this.d.profileSessions ? '' : ' Or switch to a lighter model via ⚙️ Controls to keep going now.'
              await this.d.say(
                topicId,
                until
                  ? `⏳ Rate limit hit on this model — resets at ${until}.${rotating} Otherwise I'll continue automatically then.${lighter}`
                  : `⏳ Rate limit hit on this model.${rotating} Otherwise wait a moment and send your message again.${lighter}`,
              )
              if (rot) void this.resumeAfterRotation(topicId, activeBefore)
              await this.d.onEvent(topicId, { kind: 'turn', phase: 'waiting', inFlight: 1 + l.queued, note: until ? `resets at ${until}` : undefined })
              break
            }
            case 'say': {
              // A hand-off the model wrote (after a wrap-up, or on its own) is kept: Resume sends it back.
              if (ev.text.includes(HANDOFF_MARKER) && b) {
                const h = parseHandoff(ev.text)
                if (h) {
                  // Bounded: the registry is rewritten whole on every result, and a hand-off is a
                  // member's text to make as long as they like (fifth security read).
                  b.handoff = { at: this.now(), text: h.text.slice(0, HANDOFF_MAX) }
                  this.d.store.saveRegistry()
                  if (l.wrap) l.wrap.handoff = h.text
                }
              }
              await this.d.onEvent(topicId, ev)
              break
            }
            case 'turnEnd':
            case 'turnError': {
              answered = true
              // The topic's spend, from every result, success or failure, by each total's increment
              // over the last total the transcript reported: a total at or above it continues it
              // (within a stretch, and across a resume whose transcript saved its total, per the
              // SDK); a total below it means the transcript restarted at zero (no saved total: a
              // crash or a kill mid-turn) and counts whole. Never a sum of stretch totals, never a
              // max that misses a restarted stretch, and never read against the record, which
              // charged every stretch after a lost one its history again. One bound: a restarted
              // stretch whose first turn costs at least the last reported total reads as carried,
              // and the record falls short by that total, at most once per lost transcript (the
              // SDK's usage query would settle it and is experimental). A binding recorded before
              // the reported total was kept has only its record, which serves as the baseline for
              // its first result. A stretch the SDK ended for its budget counts as the budget spent
              // whatever it reported. Tracked only where a budget exists.
              const budget = this.d.budgetUsd
              if (b && budget !== undefined) {
                let spent = b.spentUsd
                let reported = b.reportedUsd
                // A zero is no information (a crash or startup-error result may carry zeroed values).
                if (ev.costUsd !== undefined && ev.costUsd > 0) {
                  const last = reported ?? spent
                  spent = (spent ?? 0) + (last !== undefined && ev.costUsd >= last ? ev.costUsd - last : ev.costUsd)
                  reported = ev.costUsd
                }
                if (ev.kind === 'turnError' && ev.subtype === 'error_max_budget_usd') spent = Math.max(spent ?? 0, budget)
                if (spent !== b.spentUsd || reported !== b.reportedUsd) {
                  b.spentUsd = spent
                  b.reportedUsd = reported
                  this.d.store.saveRegistry()
                }
              }
              // One result ends the turn and every message folded into it.
              l.running = false
              l.queued = 0
              l.lastActive = this.now()
              this.d.metrics.inc('turns')
              let outcome: 'ok' | 'error' | 'limited' | 'wrapped' = ev.kind === 'turnEnd' ? 'ok' : ev.afterRateLimit ? 'limited' : 'error'
              let more = 0
              let report: Event = ev
              // The hand-off this wrap-up produced, never an earlier one the binding still holds.
              let handoff: string | undefined
              if (l.wrap) {
                l.wrap.resultsSeen++
                if (l.wrap.handoff !== undefined || l.wrap.resultsSeen >= 2) {
                  handoff = l.wrap.handoff
                  l.wrap = undefined
                  outcome = 'wrapped'
                  this.d.metrics.inc('wrap_ups_completed')
                } else {
                  // The first result after a wrap-up request belongs to the turn before the
                  // wrap-up's own; keep the status open for the one that follows. With `now`
                  // that turn was cut short, and the error result the cut produces when the
                  // model was mid-thought is the cut itself, not a failure. With `after-turn`
                  // the turn ran to its end, so its error is real and stays reported.
                  more = 1
                  if (l.wrap.when === 'now' && ev.kind === 'turnError' && !ev.afterRateLimit) {
                    outcome = 'ok'
                    report = { kind: 'turnEnd', afterRateLimit: false }
                  }
                }
              }
              if (report.kind === 'turnError') this.d.metrics.inc('turn_errors')
              await this.d.onEvent(topicId, report)
              if (outcome === 'wrapped') await this.d.onEvent(topicId, { kind: 'wrapped', handoff })
              await this.d.onEvent(topicId, { kind: 'turn', phase: 'end', inFlight: more, outcome })
              break
            }
            default:
              await this.d.onEvent(topicId, ev)
          }
        }
      }
    } catch (e) {
      this.d.metrics.inc('sdk_stream_errors')
      this.d.log.error('session.stream_error', { topic: topicId, error: e })
      const b = this.d.store.registry[topicId]
      // A failure before any result on a resume whose transcript is gone from disk (the CLI's own
      // cleanup removes old ones) would repeat on every message for good: the session id goes, so
      // the next message opens fresh, said on its own kind. Confirmed on disk, never inferred from
      // the failure: a transient one (auth, network, a process that would not start) keeps a
      // transcript that is still there, and a directory that could not be read is unknown, not
      // gone (seventh security read; Codex hook, three times).
      const unresumable = !!resumedId && !answered && !!b && b.sessionId === resumedId && this.d.transcriptExists?.(resumedId) === false
      if (b && unresumable) {
        b.sessionId = undefined
        if (this.d.budgetUsd !== undefined) b.reportedUsd = 0
        this.d.store.saveRegistry()
      }
      // On the reply rule: a member's message is what opens the stretch. Under a profile the
      // detail stays in the log: a spawn or transcript error names host paths.
      if (unresumable) {
        if (!this.d.replyMuted(topicId, 'resume')) await this.d.say(topicId, '⚠️ The earlier conversation here is gone and could not be resumed; the next message starts fresh.')
      } else if (!this.d.replyMuted(topicId, 'error')) {
        await this.d.say(topicId, this.d.profileSessions ? '⚠️ session error; the operator has the detail. Send your message again in a moment.' : `⚠️ session error: ${e instanceof Error ? e.message : String(e)}`)
      }
    } finally {
      // The stream ended (closed, crashed or completed): always terminate the process,
      // otherwise every resume spawns a fresh one while the old lingers.
      try {
        l.session.close()
      } catch {}
      if (this.live.get(topicId) === l) {
        this.live.delete(topicId)
        this.d.log.info('session.ended', { topic: topicId })
      }
      // Report idle only when the topic has no live session now. After a model switch the
      // old pump unwinds while the replacement is already running; an unconditional idle
      // here would close the replacement's fresh status as "stopped".
      if (!this.live.has(topicId)) await this.d.onEvent(topicId, { kind: 'state', state: 'idle' })
    }
  }
}
