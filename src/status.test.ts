import { test, expect, describe } from 'bun:test'
import { TurnStatus, renderStatus, type StatusTransport, type TurnState } from './status'

/** Records every call and lets a test fail an edit with a retry-after. */
class FakeTransport implements StatusTransport {
  created: [string, string][] = []
  createdKinds: string[] = []
  edits: [string, number, string][] = []
  editKinds: string[] = []
  removed: [string, number][] = []
  typing: string[] = []
  nextId = 100
  failEditWith: number | undefined // retry-after ms
  async create(topicId: string, text: string, kind: string): Promise<number | undefined> {
    this.created.push([topicId, text])
    this.createdKinds.push(kind)
    return this.nextId++
  }
  async edit(topicId: string, messageId: number, text: string, kind: string): Promise<{ ok: boolean; retryAfterMs?: number; gone?: boolean }> {
    if (this.failEditWith !== undefined) {
      const r = this.failEditWith
      this.failEditWith = undefined
      return { ok: false, retryAfterMs: r }
    }
    this.edits.push([topicId, messageId, text])
    this.editKinds.push(kind)
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
      lastItemAt: undefined,
    }
    const text = renderStatus(st, 192_000)
    expect(text.split('\n')[0]).toBe('⏳ Working · 3:12 · 4 tool calls · 1 message queued')
    expect(text).toContain('🖥 Typecheck and run the unit tests')
    expect(text).toContain('✏️ edited 2 files: b.ts, a.ts') // newest first
    expect(text).toContain('📖 1 read')
    // a rate-limit wait replaces the spinner line, with or without a known reset time
    expect(renderStatus({ ...st, waiting: true, waitNote: 'resets at 07:10' }, 192_000).split('\n')[0]).toBe('⏸ Rate limit hit · resets at 07:10 · 3:12')
    expect(renderStatus({ ...st, waiting: true, waitNote: undefined }, 192_000).split('\n')[0]).toBe('⏸ Rate limit hit · 3:12')
    // the render never exceeds a Telegram message
    const huge: TurnState = { ...st, items: Array.from({ length: 500 }, (_, i) => ({ kind: 'command' as const, label: `c${i} ${'x'.repeat(150)}` })) }
    expect(renderStatus(huge, 1000).length).toBeLessThanOrEqual(3500)
  })
})

describe('renderStatus quiet marker', () => {
  test('the header says how long ago the last action was once the session goes quiet', () => {
    const st: TurnState = { startedAt: 0, items: [], toolCalls: 3, inFlight: 1, frame: 0, waiting: false, waitNote: undefined, worst: 'ok', lastItemAt: 100_000 }
    // 10 s after the last action: nothing extra; the line stays short
    expect(renderStatus(st, 110_000, { now: 110_000 }).split('\n')[0]).toBe('⏳ Working · 1:50 · 3 tool calls')
    // 45 s after: the marker appears; minutes and hours format themselves
    expect(renderStatus(st, 145_000, { now: 145_000 }).split('\n')[0]).toBe('⏳ Working · 2:25 · 3 tool calls · last action 45s ago')
    expect(renderStatus(st, 400_000, { now: 400_000 }).split('\n')[0]).toContain('last action 5m ago')
    expect(renderStatus(st, 8_000_000, { now: 8_000_000 }).split('\n')[0]).toContain('last action 2h 11m ago')
    // before any action there is nothing to date
    expect(renderStatus({ ...st, lastItemAt: undefined }, 400_000, { now: 400_000 }).split('\n')[0]).not.toContain('last action')
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

  test('a wrapped-up turn ends with its own summary', async () => {
    const h = harness()
    h.s.begin('7', 2)
    await h.settle()
    h.s.addItems('7', [{ kind: 'command', label: 'x' }, { kind: 'edit', label: 'a.ts' }])
    h.s.turnEnded('7', 1, 'error') // an earlier turn failed, but a wrap-up is reported as a wrap-up
    await h.advance(20_000)
    await h.s.finish('7', 'wrapped')
    expect(h.t.edits[h.t.edits.length - 1][2]).toBe('⏹ Wrapped up · 0:20 · 2 tool calls · 1 file edited')
    // the live message carried the wrap-up button; the summary does not
    expect(h.t.createdKinds[0]).toBe('live')
    expect(h.t.editKinds[h.t.editKinds.length - 1]).toBe('summary')
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
    h.s.turnEnded('7', 1, 'error') // the first queued turn failed
    await h.advance(10_000)
    await h.s.finish('7', 'ok') // the second succeeded
    expect(h.t.edits[h.t.edits.length - 1][2].startsWith('⚠️ Ended with an error')).toBe(true)
    // a rate-limited first turn is likewise kept, and an explicit stop still reads stopped
    h.s.begin('8', 2)
    await h.settle()
    h.s.addItems('8', [{ kind: 'command', label: 'x' }])
    h.s.turnEnded('8', 1, 'limited')
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
    // budget 8: three creates, one move (two operations), leaves three for edits
    const h = harness({ maxOpsPerMinute: 8, editEveryMs: 1_000 })
    for (const t of ['1', '2', '3']) h.s.begin(t, 1)
    await h.settle()
    for (const t of ['1', '2', '3']) h.s.addItems(t, [{ kind: 'command', label: 'go ' + t }])
    expect(h.t.created.length).toBe(3) // the three creates already spent budget
    h.s.bump('1') // a move costs two operations and must be paid for as two
    for (let i = 0; i < 59; i++) await h.advance(1_000) // the whole first minute, before the creates leave the window
    const spent = h.t.created.length + h.t.edits.length + h.t.removed.length
    expect(spent).toBeLessThanOrEqual(8) // never more than the budget within one minute, moves included
    expect(h.t.removed.length).toBe(1) // the move happened and was paid for
    // every topic got at least one edit or its move: the budget is shared, not hogged by one
    for (const t of ['2', '3']) expect(h.t.edits.some(e => e[0] === t)).toBe(true)
    // and the per-topic interval stretched: with 3 topics and 8/min, 22.5 s apart, so ≤ 3 edits each in a minute
    for (const t of ['1', '2', '3']) expect(h.t.edits.filter(e => e[0] === t).length).toBeLessThanOrEqual(3)
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
    h.s.turnEnded('7', 1, 'ok')
    await h.advance(13_000)
    expect(h.t.edits[1][2]).not.toContain('queued')
  })

  test('a rate-limit wait is cleared when the next queued turn starts running', async () => {
    const h = harness()
    h.s.begin('7', 2)
    await h.settle()
    h.s.waiting('7', 'resets at 07:10')
    await h.advance(4_000)
    expect(h.t.edits[0][2].startsWith('⏸')).toBe(true)
    h.s.turnEnded('7', 1, 'limited') // the limited turn ended; the queued one is now running
    await h.advance(13_000)
    expect(h.t.edits[1][2].startsWith('⏳') || h.t.edits[1][2].startsWith('⌛')).toBe(true)
    // but the run's verdict still remembers the limit
    await h.s.finish('7', 'ok')
    expect(h.t.edits[h.t.edits.length - 1][2].startsWith('⏸ Rate limit hit')).toBe(true)
  })

  test('ticks never overlap, so a slow edit is not doubled', async () => {
    let now = 1_000_000
    let release: () => void = () => {}
    const t = new FakeTransport()
    const slowEdit = t.edit.bind(t)
    let edits = 0
    t.edit = async (topicId, id, text, kind) => {
      edits++
      await new Promise<void>(r => (release = r)) // the API hangs until the test releases it
      return slowEdit(topicId, id, text, kind)
    }
    const s = new TurnStatus(t, { now: () => now, editEveryMs: 1_000, firstEditAfterMs: 0, maxOpsPerMinute: 60 })
    s.begin('7', 1)
    await new Promise(r => setTimeout(r, 5))
    s.addItems('7', [{ kind: 'command', label: 'x' }])
    now += 2_000
    const first = s.tick() // starts the slow edit
    await new Promise(r => setTimeout(r, 5))
    now += 2_000
    await s.tick() // returns at once: the previous tick is still in flight
    await s.tick()
    expect(edits).toBe(1)
    release()
    await first
    expect(edits).toBe(1)
  })

  test('a status is not posted while the budget is exhausted and is posted once it frees', async () => {
    const h = harness({ maxOpsPerMinute: 2, editEveryMs: 60_000 })
    h.s.begin('1', 1)
    h.s.begin('2', 1)
    h.s.begin('3', 1) // the third exceeds the budget: owed, not posted
    await h.settle()
    expect(h.t.created.map(c => c[0])).toEqual(['1', '2'])
    await h.advance(30_000)
    expect(h.t.created.length).toBe(2) // still no budget
    await h.advance(31_000) // the first two creates left the window
    expect(h.t.created.map(c => c[0])).toEqual(['1', '2', '3'])
    // and a status that was never posted closes without any API call
    const removedBefore = h.t.removed.length
    const editsBefore = h.t.edits.length
    h.s.begin('4', 1)
    await h.settle()
    await h.s.finish('4', 'ok')
    expect(h.t.removed.length).toBe(removedBefore)
    expect(h.t.edits.length).toBe(editsBefore)
  })

  test('drop cancels a pending closing for that topic', async () => {
    const h = harness()
    h.s.begin('7', 1)
    await h.settle()
    h.s.addItems('7', [{ kind: 'command', label: 'x' }])
    await h.advance(10_000)
    h.t.failEditWith = 20_000
    await h.s.finish('7', 'ok')
    expect(h.s.pendingClosings()).toBe(1)
    await h.s.drop('7') // the topic was deleted
    expect(h.s.pendingClosings()).toBe(0)
    const editsBefore = h.t.edits.length
    await h.advance(30_000)
    expect(h.t.edits.length).toBe(editsBefore) // no retry against a removed topic
  })
})
