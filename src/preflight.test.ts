import { test, expect, describe } from 'bun:test'
import { compareVersions, checkClaudeVersion, MIN_CLAUDE_VERSION } from './preflight'

describe('versions', () => {
  test('compares dotted versions numerically', () => {
    expect(compareVersions('2.1.278', '2.1.99')).toBeGreaterThan(0)
    expect(compareVersions('2.1.99', '2.0.1000')).toBeGreaterThan(0)
    expect(compareVersions('2.1.251', '2.1.251')).toBe(0)
    expect(compareVersions('2.1', '2.1.0')).toBe(0)
    expect(compareVersions('1.9.9', '2.0.0')).toBeLessThan(0)
  })

  test('flags a binary older than the minimum', () => {
    const r = checkClaudeVersion('2.1.117 (Claude Code)', MIN_CLAUDE_VERSION)
    expect(r.ok).toBe(false)
    expect(r.message).toContain('2.1.117')
    expect(r.message).toContain(MIN_CLAUDE_VERSION)
    expect(checkClaudeVersion('2.1.278 (Claude Code)', MIN_CLAUDE_VERSION).ok).toBe(true)
    // unknown is reported as unknown, never as ok
    const u = checkClaudeVersion(undefined, MIN_CLAUDE_VERSION)
    expect(u.ok).toBe(false)
    expect(u.message).toMatch(/could not/i)
  })
})
