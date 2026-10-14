import { test, expect, afterEach } from 'bun:test'
import { focusEnabled, readGate } from './focus'

const KEYS = ['FOCUS_GATE', 'FOCUS_CLI', 'FOCUS_PY'] as const
const saved = Object.fromEntries(KEYS.map(k => [k, process.env[k]]))
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

const BUN = process.execPath
const VIEW = { gate: true, limit: 3, inFlight: 3, more: 0, items: [{ num: 4, id: 'abc', title: 't', source: 'vscode', topicId: null, cwd: '/w', idleMin: 9, waiting: false, state: 'open', resume: 'r' }] }

test('focusEnabled: off by env or missing CLI', () => {
  delete process.env.FOCUS_GATE
  process.env.FOCUS_CLI = import.meta.path // any existing file stands in for the tool
  expect(focusEnabled()).toBe(true)
  process.env.FOCUS_GATE = 'off'
  expect(focusEnabled()).toBe(false)
  delete process.env.FOCUS_GATE
  process.env.FOCUS_CLI = '/nonexistent/focus.py'
  expect(focusEnabled()).toBe(false)
})

test('readGate: a failing or slow CLI never blocks /new', async () => {
  const start = Date.now()
  const slow = await readGate({ argv: [BUN, '-e', 'await Bun.sleep(5000)'], timeoutMs: 300 })
  expect(slow.view).toBeUndefined()
  expect(slow.reason).toBe('timeout')
  expect(Date.now() - start).toBeLessThan(2000)
  for (const argv of [[BUN, '-e', 'process.exit(3)'], [BUN, '-e', 'console.log("{not json")'], ['/nonexistent/binary']]) {
    const r = await readGate({ argv, timeoutMs: 3000 })
    expect(r.view).toBeUndefined()
    expect(r.reason).toBeTruthy()
  }
  const good = await readGate({ argv: [BUN, '-e', `console.log(${JSON.stringify(JSON.stringify(VIEW))})`], timeoutMs: 3000 })
  expect(good.view?.gate).toBe(true)
  expect(good.view?.items[0].num).toBe(4)
})
