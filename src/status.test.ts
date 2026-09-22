import { test, expect, describe } from 'bun:test'
import { TurnStatus, renderStatus, type StatusTransport, type TurnState } from './status'

/** Records every call and lets a test fail an edit with a retry-after. */
class FakeTransport implements StatusTransport {
  created: [string, string][] = []
  edits: [string, number, string][] = []
  removed: [string, number][] = []
  typing: string[] = []
  nextId = 100
  failEditWith: number | undefined // retry-after ms
  async create(topicId: string, text: string): Promise<number | undefined> {
    this.created.push([topicId, text])
    return this.nextId++
  }
  async edit(topicId: string, messageId: number, text: string): Promise<{ ok: boolean; retryAfterMs?: number; gone?: boolean }> {
    if (this.failEditWith !== undefined) {
      const r = this.failEditWith
      this.failEditWith = undefined
      return { ok: false, retryAfterMs: r }
    }
    this.edits.push([topicId, messageId, text])
    return { ok: true }
  }
  async remove(topicId: string, messageId: number): Promise<void> {
    this.removed.push([topicId, messageId])
  }
  async type(topicId: string): Promise<void> {
    this.typing.push(topicId)
  }
}

function harness(over: { maxOpsPerMinute?: number; editEveryMs?: number } = {}) {
  let now = 1_000_000
  const t = new FakeTransport()
  const s = new TurnStatus(t, {
    now: () => now,
    editEveryMs: over.editEveryMs ?? 12_000,
    firstEditAfterMs: 3_000,
    typingEveryMs: 4_500,
    minKeepMs: 5_000,
    maxOpsPerMinute: over.maxOpsPerMinute ?? 60,
    moveDebounceMs: 1_500,
  })
  const advance = async (ms: number) => {
    now += ms
    await s.tick()
  }
  const settle = () => new Promise(r => setTimeout(r, 5))
  return { t, s, advance, settle, now: () => now }
}

describe('renderStatus', () => {
  test('the status text shows elapsed time, tool lines and queued messages', () => {
    const st: TurnState = {
      startedAt: 0,
      items: [
        { kind: 'command', label: 'Typecheck and run the unit tests' },
        { kind: 'edit', label: 'a.ts' },
        { kind: 'edit', label: 'b.ts' },
        { kind: 'read', label: 'x' },
      ],
      toolCalls: 4,
      inFlight: 2,
      frame: 0,
      waiting: false,
      waitNote: undefined,
      worst: 'ok',
    }
    const text = renderStatus(st, 192_000)
    expect(text.split('\n')[0]).toBe('⏳ Working · 3:12 · 4 tool calls · 1 message queued')
    expect(text).toContain('🖥 Typecheck and run the unit tests')
    expect(text).toContain('✏️ edited 2 files: a.ts, b.ts')
    expect(text).toContain('📖 1 read')
    // a rate-limit wait replaces the spinner line, with or without a known reset time
    expect(renderStatus({ ...st, waiting: true, waitNote: 'resets at 07:10' }, 192_000).split('\n')[0]).toBe('⏸ Rate limit hit · resets at 07:10 · 3:12')
    expect(renderStatus({ ...st, waiting: true, waitNote: undefined }, 192_000).split('\n')[0]).toBe('⏸ Rate limit hit · 3:12')
    // the render never exceeds a Telegram message
    const huge: TurnState = { ...st, items: Array.from({ length: 500 }, (_, i) => ({ kind: 'command' as const, label: `c${i} ${'x'.repeat(150)}` })) }
    expect(renderStatus(huge, 1000).length).toBeLessThanOrEqual(3500)
  })
})

describe('TurnStatus', () => {
  test('begin posts one working message and edits it at most once per interval', async () => {
    const h = harness()
    h.s.begin('7', 1)
    await h.settle()
    expect(h.t.created.length).toBe(1)
    expect(h.t.created[0][1]).toMatch(/^⏳ Working · 0:00/)
    h.s.addItems('7', [{ kind: 'command', label: 'Run tests' }])
    await h.advance(1_000) // before the first-edit delay: nothing yet
    expect(h.t.edits.length).toBe(0)
    await h.advance(2_500) // 3.5 s in: the first edit shows the tool line
    expect(h.t.edits.length).toBe(1)
    expect(h.t.edits[0][2]).toContain('🖥 Run tests')
    h.s.addItems('7', [{ kind: 'edit', label: 'a.ts' }])
    await h.advance(5_000) // 8.5 s: inside the interval, no edit even though there is news
    expect(h.t.edits.length).toBe(1)
    await h.advance(8_000) // 16.5 s: interval passed → one edit carrying both
    expect(h.t.edits.length).toBe(2)
    expect(h.t.edits[1][2]).toContain('✏️ edited a.ts')
    // a second begin while active does not create a second message
    h.s.begin('7', 2)
    await h.settle()
    expect(h.t.created.length).toBe(1)
  })

  test('edits back off after a 429 and resume when the retry-after has passed', async () => {
    const h = harness()
    h.s.begin('7', 1)
    await h.settle()
    h.s.addItems('7', [{ kind: 'command', label: 'one' }])
    h.t.failEditWith = 30_000
    await h.advance(4_000) // first edit attempt → 429 with retry-after 30 s
    expect(h.t.edits.length).toBe(0)
    await h.advance(15_000) // still inside the retry window: no attempt
    expect(h.t.edits.length).toBe(0)
    await h.advance(20_000) // past it: the edit lands
    expect(h.t.edits.length).toBe(1)
  })

  test('typing indicator is refreshed only while a turn is in flight', async () => {
    const h = harness()
    h.s.begin('7', 1)
    await h.settle()
    await h.advance(1_000)
    await h.advance(1_000)
    const afterTwo = h.t.typing.length
    expect(afterTwo).toBeGreaterThanOrEqual(1)
    await h.advance(5_000)
    expect(h.t.typing.length).toBeGreaterThan(afterTwo)
    await h.s.finish('7', 'ok')
    const done = h.t.typing.length
    await h.advance(10_000)
    await h.advance(10_000)
    expect(h.t.typing.length).toBe(done) // nothing after finish
  })

  test('finish edits the message into a summary, or deletes it after a short quiet turn', async () => {
    const h = harness()
    // long turn with tool calls → summary
    h.s.begin('7', 1)
    await h.settle()
    h.s.addItems('7', [{ kind: 'command', label: 'x' }, { kind: 'edit', label: 'a.ts' }, { kind: 'edit', label: 'b.ts' }])
    await h.advance(65_000)
    await h.s.finish('7', 'ok')
    const last = h.t.edits[h.t.edits.length - 1][2]
    expect(last).toBe('✅ Done · 1:05 · 3 tool calls · 2 files edited')
    expect(h.t.removed.length).toBe(0)
    // short turn with nothing done → deleted, no clutter under a one-line answer
    h.s.begin('8', 1)
    await h.settle()
    await h.advance(2_000)
    await h.s.finish('8', 'ok')
    expect(h.t.removed).toEqual([['8', 101]])
    // an error ends with a warning summary
    h.s.begin('9', 1)
    await h.settle()
    h.s.addItems('9', [{ kind: 'command', label: 'x' }])
    await h.advance(7_000)
    await h.s.finish('9', 'error')
    expect(h.t.edits[h.t.edits.length - 1][2]).toBe('⚠️ Ended with an error · 0:07 · 1 tool call')
  })

  test('a stopped session finishes the status even without a result', async () => {
    const h = harness()
    h.s.begin('7', 1)
    await h.settle()
    h.s.addItems('7', [{ kind: 'command', label: 'x' }])
    await h.advance(10_000)
    await h.s.finish('7', 'stopped')
    expect(h.t.edits[h.t.edits.length - 1][2]).toBe('⏹ Stopped · 0:10 · 1 tool call')
    expect(h.s.isActive('7')).toBe(false)
  })

  test('a rate limit shows as waiting in the status', async () => {
    const h = harness()
    h.s.begin('7', 1)
    await h.settle()
    h.s.waiting('7', 'resets at 07:10')
    await h.advance(4_000)
    expect(h.t.edits[0][2].startsWith('⏸ Rate limit hit · resets at 07:10')).toBe(true)
    await h.s.finish('7', 'limited')
    expect(h.t.edits[h.t.edits.length - 1][2]).toBe('⏸ Rate limit hit · resets at 07:10 · 0:04')
  })

  test('an earlier failure in a queued run is not summarized as done', async () => {
    const h = harness()
    h.s.begin('7', 2)
    await h.settle()
    h.s.addItems('7', [{ kind: 'command', label: 'x' }])
    h.s.noteOutcome('7', 'error') // the first queued turn failed
    h.s.setInFlight('7', 1)
    await h.advance(10_000)
    await h.s.finish('7', 'ok') // the second succeeded
    expect(h.t.edits[h.t.edits.length - 1][2].startsWith('⚠️ Ended with an error')).toBe(true)
    // a rate-limited first turn is likewise kept, and an explicit stop still reads stopped
    h.s.begin('8', 2)
    await h.settle()
    h.s.addItems('8', [{ kind: 'command', label: 'x' }])
    h.s.noteOutcome('8', 'limited')
    await h.advance(10_000)
    await h.s.finish('8', 'ok')
    expect(h.t.edits[h.t.edits.length - 1][2].startsWith('⏸ Rate limit hit')).toBe(true)
  })

  test('the closing summary is retried after a 429 until it lands', async () => {
    const h = harness()
    h.s.begin('7', 1)
    await h.settle()
    h.s.addItems('7', [{ kind: 'command', label: 'x' }])
    await h.advance(10_000)
    h.t.failEditWith = 20_000 // the final edit is throttled
    await h.s.finish('7', 'ok')
    expect(h.t.edits.some(e => e[2].startsWith('✅ Done'))).toBe(false)
    expect(h.s.pendingClosings()).toBe(1)
    await h.advance(10_000) // inside the retry window: no attempt
    expect(h.s.pendingClosings()).toBe(1)
    await h.advance(11_000) // past it: the summary lands and the closing is forgotten
    expect(h.t.edits[h.t.edits.length - 1][2]).toBe('✅ Done · 0:10 · 1 tool call')
    expect(h.s.pendingClosings()).toBe(0)
  })

  test('the status moves below new messages so the last message in a topic is always the timer', async () => {
    const h = harness()
    h.s.begin('7', 1)
    await h.settle()
    h.s.addItems('7', [{ kind: 'command', label: 'x' }])
    await h.advance(4_000)
    const firstId = h.t.edits[0][1]
    // Claude posts three messages in quick succession: one move, not three
    h.s.bump('7')
    await h.advance(500)
    h.s.bump('7')
    await h.advance(500)
    h.s.bump('7')
    await h.advance(1_000) // 1.0 s after the last bump: inside the debounce
    expect(h.t.removed.length).toBe(0)
    await h.advance(1_000) // 2.0 s after: the status is deleted and re-posted at the bottom
    expect(h.t.removed).toEqual([['7', firstId]])
    expect(h.t.created.length).toBe(2)
    expect(h.t.created[1][1]).toContain('🖥 x') // the text travelled with it
    const movedId = h.t.created.length + 99 // FakeTransport ids are sequential from 100
    // later edits go to the new message
    h.s.addItems('7', [{ kind: 'edit', label: 'a.ts' }])
    await h.advance(13_000)
    expect(h.t.edits[h.t.edits.length - 1][1]).toBe(movedId)
    // finishing right after another post puts the verdict at the bottom instead of editing the buried one
    h.s.bump('7')
    await h.s.finish('7', 'ok')
    expect(h.t.removed.length).toBe(2)
    expect(h.t.created[h.t.created.length - 1][1].startsWith('✅ Done')).toBe(true)
  })

  test('edits across all topics share one budget and slow down as topics multiply', async () => {
    const h = harness({ maxOpsPerMinute: 6, editEveryMs: 1_000 })
    for (const t of ['1', '2', '3']) h.s.begin(t, 1)
    await h.settle()
    for (const t of ['1', '2', '3']) h.s.addItems(t, [{ kind: 'command', label: 'go ' + t }])
    const opsBefore = h.t.created.length // the three creates already spent budget
    for (let i = 0; i < 59; i++) await h.advance(1_000) // the whole first minute, before the creates leave the window
    const spent = opsBefore + h.t.edits.length + h.t.removed.length
    expect(spent).toBeLessThanOrEqual(6) // never more than the budget within one minute
    // every topic got at least one edit: the budget is shared fairly, not hogged by one
    for (const t of ['1', '2', '3']) expect(h.t.edits.some(e => e[0] === t)).toBe(true)
    // and the per-topic interval stretched: with 3 topics and 6/min, 30 s apart, so ≤ 2 edits each in a minute
    for (const t of ['1', '2', '3']) expect(h.t.edits.filter(e => e[0] === t).length).toBeLessThanOrEqual(2)
  })

  test('typing slows down when many topics are active', async () => {
    const few = harness()
    few.s.begin('1', 1)
    await few.settle()
    for (let i = 0; i < 20; i++) await few.advance(1_000)
    const perTopicFew = few.t.typing.filter(t => t === '1').length
    const many = harness()
    for (const t of ['1', '2', '3', '4', '5']) many.s.begin(t, 1)
    await many.settle()
    for (let i = 0; i < 20; i++) await many.advance(1_000)
    const perTopicMany = many.t.typing.filter(t => t === '1').length
    expect(perTopicMany).toBeLessThan(perTopicFew)
    expect(perTopicMany).toBeGreaterThan(0)
  })

  test('queued messages are counted while a turn runs and the count falls as results arrive', async () => {
    const h = harness()
    h.s.begin('7', 1)
    await h.settle()
    h.s.setInFlight('7', 3)
    await h.advance(4_000)
    expect(h.t.edits[0][2]).toContain('2 messages queued')
    h.s.setInFlight('7', 1)
    await h.advance(13_000)
    expect(h.t.edits[1][2]).not.toContain('queued')
  })
})
