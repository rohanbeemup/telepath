import { test, expect, describe, afterEach } from 'bun:test'
import { limitEventLine, rotatorEnabled, waitForRotation } from './rotator'

// daemon.ts loads the state directory's .env AFTER its imports are evaluated, so the
// switch and the rotator paths must be read when asked, not frozen at import time.
describe('rotatorEnabled', () => {
  const saved = { ROTATOR_HANDOFF: process.env.ROTATOR_HANDOFF, CLAUDE_ROTATOR_SCRIPT: process.env.CLAUDE_ROTATOR_SCRIPT }
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })

  test('honours env set after the module was imported', () => {
    process.env.CLAUDE_ROTATOR_SCRIPT = import.meta.path // any file that exists
    delete process.env.ROTATOR_HANDOFF
    expect(rotatorEnabled()).toBe(true)
    process.env.ROTATOR_HANDOFF = 'off'
    expect(rotatorEnabled()).toBe(false)
  })

  test('no script at the configured path means no rotator', () => {
    delete process.env.ROTATOR_HANDOFF
    process.env.CLAUDE_ROTATOR_SCRIPT = import.meta.path + '.does-not-exist'
    expect(rotatorEnabled()).toBe(false)
  })
})

// The rotator's dashboard and its own tooling read limit-events.log in the shim's
// format; a line this daemon appends must be indistinguishable from the shim's.
describe('limitEventLine', () => {
  test('UTC stamp to whole seconds, one space, the raw JSON', () => {
    const line = limitEventLine(
      { type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } },
      new Date('2026-09-21T22:35:53.417Z'),
    )
    expect(line).toBe('2026-09-21T22:35:53Z {"type":"rate_limit_event","rate_limit_info":{"status":"rejected"}}')
  })
})

// After a rejection the daemon must act only on a real switch: a marker that stays,
// or that is missing, is not one — otherwise a topic would be closed and nudged for nothing.
describe('waitForRotation', () => {
  test('returns the new account once .active changes', async () => {
    const seq = ['claude_33', 'claude_33', 'claude_36']
    let i = 0
    const got = await waitForRotation('claude_33', {
      attempts: 5,
      delayMs: 1,
      readActive: () => seq[Math.min(i++, seq.length - 1)],
    })
    expect(got).toBe('claude_36')
  })

  test('gives up when nothing changes within the attempts', async () => {
    const got = await waitForRotation('claude_33', { attempts: 3, delayMs: 1, readActive: () => 'claude_33' })
    expect(got).toBeUndefined()
  })

  test('a missing marker is not a rotation', async () => {
    const got = await waitForRotation('claude_33', { attempts: 2, delayMs: 1, readActive: () => undefined })
    expect(got).toBeUndefined()
  })

  test('no marker before, one after, is a switch', async () => {
    const got = await waitForRotation(undefined, { attempts: 2, delayMs: 1, readActive: () => 'claude_36' })
    expect(got).toBe('claude_36')
  })
})
