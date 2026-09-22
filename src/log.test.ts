import { test, expect, describe } from 'bun:test'
import { Logger, Metrics, ErrorRing } from './log'

function capture() {
  const lines: string[] = []
  return { lines, sink: (l: string) => void lines.push(l) }
}

describe('Logger', () => {
  test('emits one JSON line per event with ts, level, event and fields', () => {
    const c = capture()
    const log = new Logger({ level: 'debug', sink: c.sink, now: () => new Date('2026-09-22T10:00:00Z') })
    log.info('out.sent', { topic: '7', bytes: 812 })
    expect(c.lines.length).toBe(1)
    const obj = JSON.parse(c.lines[0])
    expect(obj).toEqual({ ts: '2026-09-22T10:00:00.000Z', lvl: 'info', ev: 'out.sent', topic: '7', bytes: 812 })
  })

  test('filters below the configured level', () => {
    const c = capture()
    const log = new Logger({ level: 'warn', sink: c.sink })
    log.debug('a')
    log.info('b')
    log.warn('c')
    log.error('d')
    expect(c.lines.map(l => JSON.parse(l).ev)).toEqual(['c', 'd'])
  })
})

describe('Metrics', () => {
  test('counters increment and snapshot', () => {
    const m = new Metrics()
    m.inc('turns')
    m.inc('turns')
    m.inc('bytes', 40)
    const snap = m.snapshot()
    expect(snap.turns).toBe(2)
    expect(snap.bytes).toBe(40)
    expect(m.get('missing')).toBe(0)
    snap.turns = 99 // a snapshot is a copy
    expect(m.get('turns')).toBe(2)
  })
})

describe('ErrorRing', () => {
  test('keeps the last errors in a bounded ring', () => {
    const r = new ErrorRing(20)
    for (let i = 0; i < 30; i++) r.push({ at: i, ev: `e${i}`, message: 'x' })
    const list = r.list()
    expect(list.length).toBe(20)
    expect(list[0].ev).toBe('e10')
    expect(list[19].ev).toBe('e29')
  })
})
