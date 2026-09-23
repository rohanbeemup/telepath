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

/** A wrap-up in progress: waiting for the hand-off, then optionally dropping the queue. */
type Wrap = { dropQueue: boolean; sawHandoff: boolean; resultsSeen: number; queuedAtRequest: number }

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
   * Turns in flight: incremented per user message sent, decremented per result. The
   * CLI queues messages and answers each with its own result, so a second message sent
   * during a turn keeps the session busy until its own result arrives.
   */
  inFlight: number
  wrap?: Wrap
}

export function isBusy(l: Live): boolean {
  return l.inFlight > 0
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
    const l: Live = { session, topicId, model: b.model, cwd: b.cwd, lastActive: this.now(), inFlight: 0 }
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
    l.inFlight++
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
      l.inFlight++
      l.session.send(payload)
    }
    this.d.metrics.inc('messages_in')
    void this.d.onEvent(topicId, { kind: 'turn', phase: 'start', inFlight: l.inFlight })
    return true
  }

  /**
   * Wrap up the running turn: finish the current step (or the current turn), write a
   * hand-off, stop. The instruction jumps ahead of every queued message. With
   * `dropQueue`, the session is closed once the hand-off is in, so the messages still
   * queued behind it never run; the caller is told how many.
   */
  wrapUp(topicId: string, opts: { when: 'now' | 'after-turn'; dropQueue: boolean }): boolean {
    const l = this.live.get(topicId)
    if (!l || !isBusy(l) || l.wrap) return false
    l.wrap = { dropQueue: opts.dropQueue, sawHandoff: false, resultsSeen: 0, queuedAtRequest: Math.max(0, l.inFlight - 1) }
    l.inFlight++
    l.session.send(WRAP_UP_PROMPT, { priority: opts.when === 'now' ? 'now' : 'next' })
    this.d.metrics.inc('wrap_ups')
    this.d.log.info('session.wrap_up', { topic: topicId, when: opts.when, dropQueue: opts.dropQueue, queued: l.wrap.queuedAtRequest })
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
        for (const ev of interpret(msg, st)) {
          switch (ev.kind) {
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
              await this.d.onEvent(topicId, { kind: 'turn', phase: 'waiting', inFlight: l.inFlight, note: until ? `resets at ${until}` : undefined })
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
              l.inFlight = Math.max(0, l.inFlight - 1)
              l.lastActive = this.now()
              this.d.metrics.inc('turns')
              if (ev.kind === 'turnError') this.d.metrics.inc('turn_errors')
              await this.d.onEvent(topicId, ev)
              let outcome: 'ok' | 'error' | 'limited' | 'wrapped' = ev.kind === 'turnEnd' ? 'ok' : ev.afterRateLimit ? 'limited' : 'error'
              if (l.wrap) {
                // `now` preempts the running turn (its own result comes first), then the
                // wrap-up runs; `next` runs after it. Either way the wrap-up's result is the
                // one that follows the hand-off text, or at the latest the second result.
                l.wrap.resultsSeen++
                if (l.wrap.sawHandoff || l.wrap.resultsSeen >= 2) {
                  const w = l.wrap
                  l.wrap = undefined
                  outcome = 'wrapped'
                  const dropped = w.dropQueue ? l.inFlight : 0
                  if (w.dropQueue && l.inFlight > 0) {
                    this.closeLive(topicId, `wrapped up, ${l.inFlight} queued dropped`)
                    l.inFlight = 0
                  }
                  this.d.metrics.inc('wrap_ups_completed')
                  await this.d.onEvent(topicId, { kind: 'wrapped', handoff: b?.handoff?.text, dropped })
                }
              }
              await this.d.onEvent(topicId, { kind: 'turn', phase: 'end', inFlight: l.inFlight, outcome })
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
