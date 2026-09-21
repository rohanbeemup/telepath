import { test, expect, describe } from 'bun:test'
import { limitEventLine, waitForRotation } from './rotator'

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
