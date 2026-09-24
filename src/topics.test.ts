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
  readonly sentWith: { text: string; priority?: 'now' | 'next' }[] = []
  readonly inbox = new Mailbox<unknown>()
  closed = false
  send(text: string, opts?: { priority?: 'now' | 'next' }): void {
    this.sent.push(text)
    this.sentWith.push({ text, priority: opts?.priority })
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

    // a second message sent during the turn is folded into it: the one result answers
    // both, and the session is idle afterwards
    h.bind('queued')
    await h.tm.sendToTopic('queued', 'first')
    await h.tm.sendToTopic('queued', 'second')
    h.backend.last().emit(result())
    await h.tick()
    t += 5 * 60_000
    h.tm.evictIdle()
    expect(h.tm.isLive('queued')).toBe(false)
    // a turn the CLI began on its own (init) protects the session like a sent message does
    h.bind('own')
    await h.tm.sendToTopic('own', 'x')
    h.backend.last().emit(result())
    await h.tick()
    h.backend.last().emit({ type: 'system', subtype: 'init', session_id: 's' })
    await h.tick()
    t += 5 * 60_000
    h.tm.evictIdle()
    expect(h.tm.isLive('own')).toBe(true)
  })

  test('messages sent during a turn are folded into it and one result answers them all', async () => {
    const h = harness()
    h.bind('1')
    await h.tm.sendToTopic('1', 'a')
    await h.tm.sendToTopic('1', 'b') // sent before the CLI's init: still unanswered once it arrives
    const s = h.backend.last()
    s.emit({ type: 'system', subtype: 'init', session_id: 's' })
    await h.tick()
    expect(h.tm.live.get('1')?.queued).toBe(1)
    await h.tm.sendToTopic('1', 'c')
    await h.tm.sendToTopic('1', 'd')
    const turns = () => h.events.filter(([, ev]) => ev.kind === 'turn').map(([, ev]) => ev as Extract<Event, { kind: 'turn' }>)
    // the running turn plus three sent into it; the confirming init added no start
    expect(turns().map(t => [t.phase, t.inFlight])).toEqual([['start', 1], ['start', 2], ['start', 3], ['start', 4]])
    expect(h.tm.live.get('1')?.queued).toBe(3)
    s.emit(result())
    await h.tick()
    const ends = turns().filter(t => t.phase === 'end') as Extract<Event, { kind: 'turn'; phase: 'end' }>[]
    expect(ends.map(t => [t.inFlight, t.outcome])).toEqual([[0, 'ok']])
    expect(h.tm.live.get('1')?.running).toBe(false)
    expect(h.tm.live.get('1')?.queued).toBe(0)
    // a turn the pump did not see begin (output with no init) still counts as running
    s.emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'more' }] }, parent_tool_use_id: null, session_id: 's' })
    await h.tick()
    expect(h.tm.live.get('1')?.running).toBe(true)
    expect(turns().filter(t => t.phase === 'start').length).toBe(5)
    s.emit(result())
    await h.tick()
    expect(h.tm.live.get('1')?.running).toBe(false)
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

  test('emits turn start and end from the stream with the messages in the running turn', async () => {
    const h = harness()
    h.bind('1')
    await h.tm.sendToTopic('1', 'first')
    await h.tm.sendToTopic('1', 'second')
    const turns = () => h.events.filter(([, ev]) => ev.kind === 'turn').map(([, ev]) => ev as Extract<Event, { kind: 'turn' }>)
    expect(turns().map(t => [t.phase, t.inFlight])).toEqual([['start', 1], ['start', 2]])
    const s = h.backend.last()
    s.emit(result())
    await h.tick()
    // the CLI begins the next turn on its own: one start, then its error result
    s.emit({ type: 'system', subtype: 'init', session_id: 's' })
    s.emit({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['x'], session_id: 's' })
    await h.tick()
    expect(turns().filter(t => t.phase === 'start').map(t => t.inFlight)).toEqual([1, 2, 1])
    const ends = turns().filter(t => t.phase === 'end') as Extract<Event, { kind: 'turn'; phase: 'end' }>[]
    expect(ends.map(t => [t.inFlight, t.outcome])).toEqual([[0, 'ok'], [0, 'error']])
    // a rejection reports the wait to the status
    s.emit({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } })
    await h.tick()
    expect(turns().some(t => t.phase === 'waiting')).toBe(true)
  })

  test('a stale pump does not report idle once a replacement session is live', async () => {
    const h = harness()
    h.bind('1')
    await h.tm.sendToTopic('1', 'x')
    const old = h.backend.sessions[0]
    // model switch: close, then the next message opens a replacement before the old
    // pump's stream has finished unwinding
    h.tm.closeLive('1', 'model switch')
    await h.tm.sendToTopic('1', 'y')
    expect(h.backend.opens.length).toBe(2)
    old.inbox.close() // the old stream now ends
    await h.tick()
    const idles = h.events.filter(([t, ev]) => t === '1' && ev.kind === 'state' && ev.state === 'idle')
    expect(idles.length).toBe(0)
    // when the replacement itself ends and nothing is live, idle IS reported
    h.backend.last().inbox.close()
    await h.tick()
    expect(h.events.filter(([t, ev]) => t === '1' && ev.kind === 'state' && ev.state === 'idle').length).toBe(1)
  })

  test('a wrap-up sends the hand-off instruction ahead of the queue and marks the next result as wrapped', async () => {
    const h = harness()
    h.bind('1')
    await h.tm.sendToTopic('1', 'long job')
    await h.tm.sendToTopic('1', 'queued one')
    const s = h.backend.last()
    expect(h.tm.wrapUp('1', { when: 'now' })).toBe(true)
    expect(h.tm.wrapUp('1', { when: 'now' })).toBe(false) // one wrap-up at a time
    const wrap = s.sentWith[s.sentWith.length - 1]
    expect(wrap.priority).toBe('now')
    expect(wrap.text).toContain('📋 Handoff')
    // the preempted turn ends first (its own result, which must not close the status),
    // then the CLI begins the wrap-up turn, which writes the hand-off
    s.emit(result())
    await h.tick()
    s.emit({ type: 'system', subtype: 'init', session_id: 's' })
    s.emit({ type: 'assistant', message: { content: [{ type: 'text', text: '📋 Handoff\nDone: a\nOpen: b\nResume: continue with c' }] }, parent_tool_use_id: null, session_id: 's' })
    s.emit(result())
    await h.tick()
    const ends = h.events.filter(([, ev]) => ev.kind === 'turn' && ev.phase === 'end') as [string, Extract<Event, { kind: 'turn'; phase: 'end' }>][]
    expect(ends.map(([, e]) => [e.inFlight, e.outcome])).toEqual([[1, 'ok'], [0, 'wrapped']])
    const wrapped = h.events.find(([, ev]) => ev.kind === 'wrapped')?.[1] as Extract<Event, { kind: 'wrapped' }>
    expect(wrapped.handoff).toContain('Resume: continue with c')
    expect(h.tm.isLive('1')).toBe(true) // the session stays; the transcript keeps the context
    expect(h.tm.live.get('1')?.running).toBe(false)
    // "after this turn" uses the next-priority slot
    h.bind('2')
    await h.tm.sendToTopic('2', 'x')
    h.tm.wrapUp('2', { when: 'after-turn' })
    expect(h.backend.last().sentWith[1].priority).toBe('next')
    // not busy → nothing to wrap
    h.bind('3')
    expect(h.tm.wrapUp('3', { when: 'now' })).toBe(false)
  })

  test('the turn a wrap-up cuts short is not reported as an error, and a second result completes the wrap-up without a hand-off', async () => {
    const h = harness()
    h.bind('1')
    h.store.registry['1'].handoff = { at: 0, text: '📋 Handoff\nResume: an earlier wrap-up' } // must not be offered as this one's
    await h.tm.sendToTopic('1', 'long job')
    const s = h.backend.last()
    h.tm.wrapUp('1', { when: 'now' })
    // a `now` message that lands while the model is mid-thought ends the turn at once with an error result
    s.emit({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: [], session_id: 's' })
    await h.tick()
    expect(h.events.some(([, ev]) => ev.kind === 'turnError')).toBe(false)
    expect(h.events.some(([, ev]) => ev.kind === 'turnEnd')).toBe(true)
    let ends = h.events.filter(([, ev]) => ev.kind === 'turn' && ev.phase === 'end') as [string, Extract<Event, { kind: 'turn'; phase: 'end' }>][]
    expect(ends.map(([, e]) => [e.inFlight, e.outcome])).toEqual([[1, 'ok']])
    // the wrap-up turn ends without a hand-off in the expected shape: still wrapped, hand-off absent
    s.emit({ type: 'system', subtype: 'init', session_id: 's' })
    s.emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'Stopped.' }] }, parent_tool_use_id: null, session_id: 's' })
    s.emit(result())
    await h.tick()
    ends = h.events.filter(([, ev]) => ev.kind === 'turn' && ev.phase === 'end') as [string, Extract<Event, { kind: 'turn'; phase: 'end' }>][]
    expect(ends.map(([, e]) => e.outcome)).toEqual(['ok', 'wrapped'])
    const wrapped = h.events.find(([, ev]) => ev.kind === 'wrapped')?.[1] as Extract<Event, { kind: 'wrapped' }>
    expect(wrapped.handoff).toBeUndefined()
    expect(h.store.registry['1'].handoff?.text).toContain('an earlier wrap-up') // the stored one is untouched
    expect(h.tm.live.get('1')?.wrap).toBeUndefined() // a new wrap-up is possible next time
    // a real error in an ordinary turn is still reported
    await h.tm.sendToTopic('1', 'again')
    s.emit({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['boom'], session_id: 's' })
    await h.tick()
    expect(h.events.some(([, ev]) => ev.kind === 'turnError')).toBe(true)
    // "finish this turn first" lets the turn run to its end, so its error is real and reported
    h.bind('2')
    await h.tm.sendToTopic('2', 'x')
    const s2 = h.backend.last()
    h.tm.wrapUp('2', { when: 'after-turn' })
    s2.emit({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['real'], session_id: 's2' })
    await h.tick()
    const errs2 = h.events.filter(([t, ev]) => t === '2' && ev.kind === 'turnError')
    expect(errs2.length).toBe(1)
    const end2 = h.events.filter(([t, ev]) => t === '2' && ev.kind === 'turn' && ev.phase === 'end') as [string, Extract<Event, { kind: 'turn'; phase: 'end' }>][]
    expect(end2.map(([, e]) => [e.inFlight, e.outcome])).toEqual([[1, 'error']])
  })

  test('a wrap-up cancels a pending rate-limit nudge and rotation watch', async () => {
    let release: (v: string) => void = () => {}
    const rotator = fakeRotator({ enabled: () => true, active: () => 'claude_33', waitForRotation: () => new Promise(r => (release = r)) })
    const h = harness({ rotator, resumeBufferMs: 0 })
    h.bind('1')
    await h.tm.sendToTopic('1', 'long job')
    const s = h.backend.last()
    s.emit({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: Date.now() + 30 } }) // the turn is still running, so a wrap-up is possible
    await h.tick()
    expect(h.tm.wrapUp('1', { when: 'now' })).toBe(true)
    release('claude_36') // the rotation lands after the wrap-up was requested
    await new Promise(r => setTimeout(r, 80)) // and the reset nudge would have fired by now
    expect(s.closed).toBe(false)
    expect(h.backend.opens.length).toBe(1)
    expect(h.said.some(([, text]) => text.startsWith('🔁') || text.startsWith('▶️'))).toBe(false)
    expect(s.sent.filter(m => m.includes('Continue with the task')).length).toBe(0)
    expect(s.sent[s.sent.length - 1]).toContain('📋 Handoff') // the wrap instruction is the last thing sent
  })

  test("a hand-off in the model's text is remembered for resume", async () => {
    const h = harness()
    h.bind('1')
    await h.tm.sendToTopic('1', 'x')
    const s = h.backend.last()
    s.emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'Stopping here.\n\n📋 Handoff\nDone: typecheck green\nOpen: build pending\nResume: run pnpm build in repo X on branch y' }] }, parent_tool_use_id: null, session_id: 's' })
    await h.tick()
    expect(h.store.registry['1'].handoff?.text.startsWith('📋 Handoff')).toBe(true)
    expect(h.store.registry['1'].handoff?.text).toContain('Resume: run pnpm build')
    // ordinary text does not overwrite it
    s.emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] }, parent_tool_use_id: null, session_id: 's' })
    await h.tick()
    expect(h.store.registry['1'].handoff?.text).toContain('Resume: run pnpm build')
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
