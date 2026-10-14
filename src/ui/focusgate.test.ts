import { test, expect } from 'bun:test'
import {
  GATE_TTL_MS,
  HeldCreations,
  gatedEntry,
  parseGateView,
  planResume,
  runGateTap,
  shouldGate,
  type GateEffects,
  type GateItem,
  type GateView,
  type HeldCreation,
} from './focusgate'

const item = (num: number, over: Partial<GateItem> = {}): GateItem => ({
  num,
  id: `${String(num).padStart(8, '0')}-0000-4000-8000-000000000000`,
  title: `item ${num}`,
  source: 'vscode',
  topicId: null,
  cwd: '/w',
  idleMin: 60,
  waiting: false,
  state: 'open',
  resume: `cd /w && claude --resume ${num}`,
  ...over,
})
const view = (over: Partial<GateView> = {}): GateView => ({ gate: true, limit: 3, inFlight: 3, items: [item(1), item(2), item(3)], more: 0, ...over })
const held = (over: Partial<HeldCreation> = {}): HeldCreation => ({
  kind: 'new',
  uid: 'u1',
  topicId: '7',
  name: 'relay fix',
  cwd: '/repo',
  model: 'claude-opus-5',
  effort: 'high',
  auto: true,
  view: view(),
  ...over,
})

function effects(markOk = true): GateEffects & { log: string[]; created: HeldCreation[]; notices: string[] } {
  const log: string[] = []
  const created: HeldCreation[] = []
  const notices: string[] = []
  return {
    log,
    created,
    notices,
    create: async h => void (log.push('create'), created.push(h)),
    mark: async n => (log.push(`mark ${n}`), markOk),
    parkIdle: async () => (log.push('park-idle'), markOk),
    resume: async i => void log.push(`resume ${i.num}`),
    notice: async t => void (log.push('notice'), notices.push(t)),
    cancel: async () => void log.push('cancel'),
  }
}

test('focus gate: parses the CLI JSON and rejects junk', () => {
  const v = parseGateView(JSON.stringify(view({ more: 2 })))
  expect(v?.gate).toBe(true)
  expect(v?.items.map(i => i.num)).toEqual([1, 2, 3])
  expect(v?.more).toBe(2)
  for (const raw of ['{"gate": tr', '[]', '"x"', 'null', JSON.stringify({ ...view(), items: 'no' }),
    JSON.stringify({ ...view(), items: [{ title: 'no number' }] }), JSON.stringify({ ...view(), gate: 'yes' })]) {
    expect(parseGateView(raw)).toBeUndefined()
  }
  // the tool answers gate:false when it cannot compute one; telepath must be able to tell
  const broken = parseGateView(JSON.stringify({ gate: false, limit: 3, inFlight: 0, items: [], more: 0, error: 'CorruptState: observations.json' }))
  expect(broken?.gate).toBe(false)
  expect(broken?.error).toBe('CorruptState: observations.json')
  expect(parseGateView(JSON.stringify({ gate: false, limit: 3, inFlight: 0, items: [], more: 0, reason: 'no scan yet' }))?.reason).toBe('no scan yet')
  expect(parseGateView(JSON.stringify(view()))?.error).toBeUndefined()
})

test('focus gate: resume opens the holding topic, refuses a recently written session, else attaches', () => {
  const now = 10_000_000_000
  const min = 60_000
  expect(planResume({ boundTopicId: '77', lastModifiedMs: now - 5 * min, now })).toEqual({ kind: 'link', topicId: '77' })
  expect(planResume({ lastModifiedMs: now - 5 * min, now })).toEqual({ kind: 'busy', minutesAgo: 5 })
  expect(planResume({ lastModifiedMs: now - 29 * min, now }).kind).toBe('busy')
  expect(planResume({ lastModifiedMs: now - 31 * min, now })).toEqual({ kind: 'attach' })
  expect(planResume({ now })).toEqual({ kind: 'missing' })
})

test('focus gate: only new-session entry points are gated', () => {
  for (const k of ['new', 'quick', 'wizard', 'newhere'] as const) expect(gatedEntry(k)).toBe(true)
  for (const k of ['attach', 'resume', 'sess'] as const) expect(gatedEntry(k)).toBe(false)
})

test('focus gate: start anyway creates with the held parameters', async () => {
  const store = new HeldCreations()
  const h = held()
  const token = store.hold(h)
  const fx = effects()
  expect(await runGateTap({ token, action: 'go' }, store, fx)).toBe('created')
  expect(fx.created).toEqual([h])
  expect(fx.log).toEqual(['create'])
})

test('focus gate: park marks then creates, even when the mark fails', async () => {
  const store = new HeldCreations()
  const ok = effects(true)
  expect(await runGateTap({ token: store.hold(held()), action: 'park', index: 1 }, store, ok)).toBe('created')
  expect(ok.log).toEqual(['mark 2', 'create'])

  const failed = effects(false)
  expect(await runGateTap({ token: store.hold(held()), action: 'park', index: 0 }, store, failed)).toBe('created')
  expect(failed.log).toEqual(['mark 1', 'create', 'notice'])
  expect(failed.notices[0]).toContain('#1')

  const idle = effects(true)
  expect(await runGateTap({ token: store.hold(held()), action: 'parkidle' }, store, idle)).toBe('created')
  expect(idle.log).toEqual(['park-idle', 'create'])
})

test('focus gate: an expired or unknown token says send /new again', async () => {
  // random, so a daemon restart does not hand out the tokens still on old buttons
  expect(new HeldCreations().hold(held())).not.toBe(new HeldCreations().hold(held()))
  let t = 0
  const store = new HeldCreations({ now: () => t })
  const late = store.hold(held())
  t = GATE_TTL_MS + 1
  const fx = effects()
  expect(await runGateTap({ token: late, action: 'go' }, store, fx)).toBe('expired')
  expect(await runGateTap({ token: 'nosuchtoken', action: 'park', index: 0 }, store, fx)).toBe('expired')
  expect(fx.created).toEqual([])
  expect(fx.log).toEqual(['notice', 'notice'])
  expect(fx.notices.every(n => n.includes('/new'))).toBe(true)
  const once = store.hold(held())
  expect(await runGateTap({ token: once, action: 'go' }, store, fx)).toBe('created')
  expect(await runGateTap({ token: once, action: 'go' }, store, fx)).toBe('expired')
  expect(fx.created.length).toBe(1)
})

test('focus gate: under the limit or disabled shows nothing', () => {
  expect(shouldGate(view(), true)).toBe(true)
  expect(shouldGate(view({ gate: false }), true)).toBe(false)
  expect(shouldGate(undefined, true)).toBe(false)
  expect(shouldGate(view(), false)).toBe(false)
})
