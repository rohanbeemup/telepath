import { test, expect, describe } from 'bun:test'
import { TopicManager, type LiveSession, type OpenOptions, type SessionBackend, type Rotator } from './topics'
import { Mailbox } from './mailbox'
import { Store } from './state'
import { buildCatalog } from './models'
import { Logger, Metrics } from './log'
import type { Event } from './interpret'

const catalog = buildCatalog({
  ids: { haiku: 'claude-haiku-4-5', sonnet: 'claude-sonnet-5', opus: 'claude-opus-5', fable: 'claude-fable-5-1' },
  enabled: ['haiku', 'sonnet', 'opus', 'fable'],
})

class FakeSession implements LiveSession {
  readonly sent: string[] = []
  readonly inbox = new Mailbox<unknown>()
  closed = false
  send(text: string): void {
    this.sent.push(text)
  }
  stream(): AsyncIterable<unknown> {
    return this.inbox
  }
  close(): void {
    this.closed = true
    this.inbox.close()
  }
  /** Simulate the CLI emitting a message. */
  emit(msg: unknown): void {
    this.inbox.push(msg)
  }
}

class FakeBackend implements SessionBackend {
  readonly opens: OpenOptions[] = []
  readonly sessions: FakeSession[] = []
  open(opts: OpenOptions): LiveSession {
    this.opens.push(opts)
    const s = new FakeSession()
    this.sessions.push(s)
    return s
  }
  last(): FakeSession {
    return this.sessions[this.sessions.length - 1]
  }
}

function fakeRotator(over: Partial<Rotator> = {}): Rotator & { handedOff: unknown[] } {
  const handedOff: unknown[] = []
  return {
    handedOff,
    enabled: () => false,
    active: () => undefined,
    handOff: m => void handedOff.push(m),
    waitForRotation: async () => undefined,
    ...over,
  }
}

type FakeRotator = ReturnType<typeof fakeRotator>

function harness(over: { maxLive?: number; idleMinutes?: number; rotator?: FakeRotator; now?: () => number; resumeBufferMs?: number } = {}) {
  const store = new Store('/nowhere', {}, { defaultModel: 'claude-opus-5', defaultCwd: '/w' }, { defaultModel: 'claude-opus-5', defaultCwd: '/w' })
  // never touch disk in these tests
  store.saveRegistry = () => {}
  store.savePrefs = () => {}
  const backend = new FakeBackend()
  const said: [string, string][] = []
  const events: [string, Event][] = []
  const rotator = over.rotator ?? fakeRotator()
  const extras = { canUseTool: (async () => ({ behavior: 'allow' })) as any, hooks: {} }
  const tm = new TopicManager({
    store,
    catalog,
    idleMinutes: over.idleMinutes ?? 15,
    maxLiveSessions: over.maxLive ?? 3,
    backend,
    baseEnv: () => ({ PATH: '/bin', TELEGRAM_BOT_TOKEN: 'secret', CLAUDE_CODE_EFFORT_LEVEL: 'low' }),
    outboxDir: t => `/out/${t}`,
    extras: () => extras,
    say: async (t, text) => void said.push([t, text]),
    onEvent: async (t, ev) => void events.push([t, ev]),
    rotator,
    log: new Logger({ level: 'error', sink: () => {} }),
    metrics: new Metrics(),
    now: over.now,
    resumeBufferMs: over.resumeBufferMs,
  })
  const bind = (topicId: string, b: Partial<{ model: string; effort: 'low' | 'high' | 'max'; sessionId: string; auto: boolean }> = {}) => {
    store.registry[topicId] = { cwd: '/w', model: b.model ?? 'claude-opus-5', effort: b.effort, sessionId: b.sessionId, title: 't' + topicId, lastActive: 0, auto: b.auto }
  }
  const tick = () => new Promise(r => setTimeout(r, 5))
  return { store, backend, said, events, tm, bind, tick, rotator }
}

const result = (sid = 's') => ({ type: 'result', subtype: 'success', is_error: false, session_id: sid })

describe('TopicManager', () => {
  test('opens a session on first message and reuses it while live', async () => {
    const h = harness()
    h.bind('1')
    await h.tm.sendToTopic('1', 'hello')
    await h.tm.sendToTopic('1', 'again')
    expect(h.backend.opens.length).toBe(1)
    expect(h.backend.last().sent.length).toBe(2)
    // the first message carries the outbox contract, the second does not
    expect(h.backend.last().sent[0]).toContain('/out/1')
    expect(h.backend.last().sent[1]).toBe('again')
  })

  test('evicts the least recently active session when the cap is reached and tells that topic', async () => {
    let t = 1000
    const h = harness({ maxLive: 2, now: () => t })
    h.bind('a')
    h.bind('b')
    h.bind('c')
    await h.tm.sendToTopic('a', 'x')
    t += 10
    await h.tm.sendToTopic('b', 'x')
    t += 10
    await h.tm.sendToTopic('c', 'x')
    expect(h.tm.isLive('a')).toBe(false)
    expect(h.tm.isLive('b')).toBe(true)
    expect(h.tm.isLive('c')).toBe(true)
    expect(h.backend.sessions[0].closed).toBe(true)
    expect(h.said.find(([topic, text]) => topic === 'a' && text.includes('Paused'))).toBeTruthy()
  })

  test('evicts idle sessions and leaves a session mid-turn alone', async () => {
    let t = 0
    const h = harness({ idleMinutes: 1, now: () => t })
    h.bind('idle')
    h.bind('busy')
    await h.tm.sendToTopic('idle', 'x')
    await h.tm.sendToTopic('busy', 'x')
    // the idle topic's turn finished; the busy one is still running
    h.backend.sessions[0].emit(result())
    await h.tick()
    t = 5 * 60_000
    h.tm.evictIdle()
    expect(h.tm.isLive('idle')).toBe(false)
    expect(h.tm.isLive('busy')).toBe(true)

    // two messages queued: the first result does not make the session idle
    h.bind('queued')
    await h.tm.sendToTopic('queued', 'first')
    await h.tm.sendToTopic('queued', 'second')
    h.backend.last().emit(result())
    await h.tick()
    t += 5 * 60_000
    h.tm.evictIdle()
    expect(h.tm.isLive('queued')).toBe(true)
    h.backend.last().emit(result())
    await h.tick()
    t += 5 * 60_000
    h.tm.evictIdle()
    expect(h.tm.isLive('queued')).toBe(false)
  })

  test('a model or effort switch closes the live session so the next message resumes with the new options', async () => {
    const h = harness()
    h.bind('1', { model: 'claude-opus-5', effort: 'high' })
    await h.tm.sendToTopic('1', 'x')
    h.store.registry['1'].model = 'claude-fable-5-1'
    h.store.registry['1'].effort = 'max'
    h.tm.closeLive('1', 'model switch')
    expect(h.backend.sessions[0].closed).toBe(true)
    await h.tm.sendToTopic('1', 'y')
    expect(h.backend.opens.length).toBe(2)
    expect(h.backend.opens[1].model).toBe('claude-fable-5-1')
    expect(h.backend.opens[1].effort).toBe('max')
    // Haiku gets no effort even if one is stored
    h.store.registry['1'].model = 'claude-haiku-4-5'
    h.tm.closeLive('1', 'switch')
    await h.tm.sendToTopic('1', 'z')
    expect(h.backend.opens[2].effort).toBeUndefined()
  })

  test('resumes with the recorded session id and records it once produced', async () => {
    const h = harness()
    h.bind('1', { sessionId: 'old-id' })
    await h.tm.sendToTopic('1', 'x')
    expect(h.backend.opens[0].resume).toBe('old-id')
    h.bind('2')
    await h.tm.sendToTopic('2', 'x')
    expect(h.backend.opens[1].resume).toBeUndefined()
    h.backend.sessions[1].emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] }, parent_tool_use_id: null, session_id: 'new-id' })
    await h.tick()
    expect(h.store.registry['2'].sessionId).toBe('new-id')
    expect(h.events.some(([t, ev]) => t === '2' && ev.kind === 'sessionId')).toBe(true)
    expect(h.events.some(([t, ev]) => t === '2' && ev.kind === 'say' && ev.text === 'hi')).toBe(true)
  })

  test('schedules a resume nudge for a usable resetsAt and cancels it when the user takes over', async () => {
    const h = harness({ resumeBufferMs: 0 })
    h.bind('1')
    await h.tm.sendToTopic('1', 'x')
    const s = h.backend.last()
    // resets 30 ms from now → nudge fires unless the user intervenes
    s.emit({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: Date.now() + 30 } })
    await h.tick()
    expect(h.said.some(([, text]) => text.startsWith('⏳ Rate limit hit'))).toBe(true)
    await h.tm.sendToTopic('1', 'I am here') // takeover cancels the nudge
    await new Promise(r => setTimeout(r, 80))
    expect(h.said.some(([, text]) => text.startsWith('▶️'))).toBe(false)
    expect(s.sent.filter(m => m.includes('has reset')).length).toBe(0)

    // without a takeover the nudge arrives
    h.bind('2')
    await h.tm.sendToTopic('2', 'x')
    h.backend.last().emit({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: Date.now() + 20 } })
    await new Promise(r => setTimeout(r, 80))
    expect(h.said.some(([t, text]) => t === '2' && text.startsWith('▶️'))).toBe(true)
    expect(h.backend.last().sent.some(m => m.includes('has reset'))).toBe(true)
  })

  test('a rotation while the user took over does not interrupt the topic', async () => {
    let release: (v: string) => void = () => {}
    const rotator = fakeRotator({ enabled: () => true, active: () => 'claude_33', waitForRotation: () => new Promise(r => (release = r)) })
    const h = harness({ rotator })
    h.bind('1')
    await h.tm.sendToTopic('1', 'x')
    const s = h.backend.last()
    s.emit({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } })
    await h.tick()
    await h.tm.sendToTopic('1', 'never mind, do this instead') // takeover
    release('claude_36')
    await h.tick()
    expect(s.closed).toBe(false)
    expect(h.backend.opens.length).toBe(1)
    expect(h.said.some(([, text]) => text.startsWith('🔁'))).toBe(false)
  })

  test('a rotation with the topic untouched closes the session and continues', async () => {
    const rotator = fakeRotator({ enabled: () => true, active: () => 'claude_33', waitForRotation: async () => 'claude_36' })
    const h = harness({ rotator })
    h.bind('1')
    await h.tm.sendToTopic('1', 'x')
    const s = h.backend.last()
    s.emit({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } })
    await h.tick()
    await h.tick()
    expect(s.closed).toBe(true)
    expect(h.backend.opens.length).toBe(2)
    expect(h.said.some(([, text]) => text.startsWith('🔁 Account rotated to claude_36'))).toBe(true)
    expect(h.backend.last().sent.some(m => m.includes('switching accounts'))).toBe(true)
    // every rate-limit event, rejected or not, reached the rotator
    expect(h.rotator.handedOff.length).toBe(1)
  })

  test('never leaks the bot token into a session environment', async () => {
    const h = harness()
    h.bind('1')
    await h.tm.sendToTopic('1', 'x')
    const env = h.backend.opens[0].env
    expect(env.TELEGRAM_BOT_TOKEN).toBeUndefined()
    expect(env.CLAUDE_CODE_EFFORT_LEVEL).toBeUndefined()
    expect(env.PATH).toBe('/bin')
    expect(env.TELEPATH_OUTBOX).toBe('/out/1')
  })

  test('a stale rate-limit alert does not suppress the next turn\'s error notice', async () => {
    const h = harness()
    h.bind('1')
    await h.tm.sendToTopic('1', 'x')
    const s = h.backend.last()
    s.emit({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } })
    s.emit({ type: 'result', subtype: 'success', is_error: true, result: 'cut off', session_id: 's' })
    await h.tick()
    s.emit({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['boom'], session_id: 's' })
    await h.tick()
    const errs = h.events.filter(([, ev]) => ev.kind === 'turnError') as [string, Extract<Event, { kind: 'turnError' }>][]
    expect(errs.length).toBe(2)
    expect(errs[0][1].afterRateLimit).toBe(true)
    expect(errs[1][1].afterRateLimit).toBe(false)
  })
})
