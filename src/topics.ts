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
import type { Store } from './state'
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
type Wrap = { sawHandoff: boolean; resultsSeen: number }

export interface SessionBackend {
  open(opts: OpenOptions): LiveSession
}

export type Live = {
  session: LiveSession
  topicId: string
  model: string
  cwd: string
  lastActive: number
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
    `Anything placed there is delivered to the user in this chat automatically — images as photos, other files as documents. ` +
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

  private enforceCap(): void {
    while (this.live.size >= this.d.maxLiveSessions) {
      let oldest: Live | undefined
      for (const l of this.live.values()) if (!oldest || l.lastActive < oldest.lastActive) oldest = l
      if (!oldest) break
      void this.d.say(oldest.topicId, `💤 Paused to free a slot (max ${this.d.maxLiveSessions} live sessions). Send a message here to resume — your context is kept.`)
      this.d.metrics.inc('sessions_evicted_cap')
      this.closeLive(oldest.topicId, 'evicted (session cap)')
    }
  }

  ensureLive(topicId: string): Live | undefined {
    const existing = this.live.get(topicId)
    if (existing) return existing
    const b = this.d.store.registry[topicId]
    if (!b) return undefined
    this.enforceCap()
    // Child sessions must not see the bot token: a prompt-injected session could read
    // it from the environment and exfiltrate it. Nothing else of ours leaks either.
    const env: Record<string, string | undefined> = { ...this.d.baseEnv(), TELEPATH_OUTBOX: this.d.outboxDir(topicId) }
    delete env.TELEGRAM_BOT_TOKEN
    delete env.CLAUDE_CODE_EFFORT_LEVEL // effort is an option now; an inherited value would override it
    const session = this.d.backend.open({
      topicId,
      cwd: b.cwd,
      model: b.model,
      effort: effortFor(this.d.catalog, b),
      resume: b.sessionId,
      env,
      ...this.d.extras(topicId),
    })
    const l: Live = { session, topicId, model: b.model, cwd: b.cwd, lastActive: this.now(), running: false, queued: 0 }
    this.live.set(topicId, l)
    this.d.metrics.inc('sessions_opened')
    this.d.log.info('session.open', { topic: topicId, model: b.model, effort: effortFor(this.d.catalog, b) ?? null, resume: b.sessionId ?? null })
    void this.pump(l)
    return l
  }

  /** A user (or a nudge) message into the topic's session. */
  async sendToTopic(topicId: string, text: string, opts: { takeover?: boolean } = {}): Promise<boolean> {
    if (opts.takeover !== false) this.userTookOver(topicId)
    let l = this.ensureLive(topicId)
    if (!l) return false
    l.lastActive = this.now()
    let payload = text
    if (!this.primed.has(topicId)) {
      this.primed.add(topicId)
      payload = `<telepath>\n${outboxContract(this.d.outboxDir(topicId))}\n</telepath>\n\n${text}`
    }
    try {
      l.session.send(payload)
    } catch (e) {
      // A stale handle slipped through: evict and open once more.
      this.d.log.warn('session.send_failed', { topic: topicId, error: e })
      this.live.delete(topicId)
      const l2 = this.ensureLive(topicId)
      if (!l2) return false
      l = l2
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

  /** The stream shows a turn beginning: from init, or from output when no turn was known. */
  private turnBegan(l: Live): void {
    const known = l.running
    l.running = true
    l.queued = 0 // whatever was sent before this point is in the turn now
    if (!known) void this.d.onEvent(l.topicId, { kind: 'turn', phase: 'start', inFlight: 1 })
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
    l.wrap = { sawHandoff: false, resultsSeen: 0 }
    l.session.send(WRAP_UP_PROMPT, { priority: opts.when === 'now' ? 'now' : 'next' })
    this.d.metrics.inc('wrap_ups')
    this.d.log.info('session.wrap_up', { topic: topicId, when: opts.when, queued: l.queued })
    return true
  }

  /** Idle eviction: a session with no turn in flight and nothing said for idleMinutes. */
  evictIdle(): void {
    const cutoff = this.now() - this.d.idleMinutes * 60_000
    for (const l of [...this.live.values()]) {
      if (!isBusy(l) && l.lastActive < cutoff) {
        this.d.metrics.inc('sessions_evicted_idle')
        this.closeLive(l.topicId, 'idle')
      }
    }
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
        void this.d.say(topicId, '▶️ Rate limit reset — resuming automatically.')
        void this.sendToTopic(topicId, CONTINUE_AFTER_LIMIT, { takeover: false })
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
    await this.d.say(topicId, `🔁 Account rotated to ${now} — continuing now.`)
    await this.sendToTopic(topicId, CONTINUE_AFTER_ROTATION, { takeover: false })
  }

  private async pump(l: Live): Promise<void> {
    const topicId = l.topicId
    const st = newPumpState(this.d.store.registry[topicId]?.sessionId)
    try {
      for await (const msg of l.session.stream()) {
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
              const rotating = rot ? ' If the account rotator switches accounts I continue right away.' : ''
              await this.d.say(
                topicId,
                until
                  ? `⏳ Rate limit hit on this model — resets at ${until}.${rotating} Otherwise I'll continue automatically then, or switch to a lighter model via ⚙️ Controls to keep going now.`
                  : `⏳ Rate limit hit on this model.${rotating} Otherwise wait a moment and send your message again, or switch to a lighter model via ⚙️ Controls.`,
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
                  b.handoff = { at: this.now(), text: h.text }
                  this.d.store.saveRegistry()
                  if (l.wrap) l.wrap.sawHandoff = true
                }
              }
              await this.d.onEvent(topicId, ev)
              break
            }
            case 'turnEnd':
            case 'turnError': {
              // One result ends the turn and every message folded into it.
              l.running = false
              l.queued = 0
              l.lastActive = this.now()
              this.d.metrics.inc('turns')
              let outcome: 'ok' | 'error' | 'limited' | 'wrapped' = ev.kind === 'turnEnd' ? 'ok' : ev.afterRateLimit ? 'limited' : 'error'
              let more = 0
              let report: Event = ev
              if (l.wrap) {
                l.wrap.resultsSeen++
                if (l.wrap.sawHandoff || l.wrap.resultsSeen >= 2) {
                  l.wrap = undefined
                  outcome = 'wrapped'
                  this.d.metrics.inc('wrap_ups_completed')
                } else {
                  // The first result after a wrap-up request is the turn it cut short (a
                  // `now` message ends it at once, as an error result when the model was
                  // mid-thought). The wrap-up's own turn follows: keep the status open and
                  // report no error for the cut itself.
                  more = 1
                  if (ev.kind === 'turnError' && !ev.afterRateLimit) {
                    outcome = 'ok'
                    report = { kind: 'turnEnd', afterRateLimit: false }
                  }
                }
              }
              if (report.kind === 'turnError') this.d.metrics.inc('turn_errors')
              await this.d.onEvent(topicId, report)
              if (outcome === 'wrapped') await this.d.onEvent(topicId, { kind: 'wrapped', handoff: b?.handoff?.text })
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
      await this.d.say(topicId, `⚠️ session error: ${e instanceof Error ? e.message : String(e)}`)
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
