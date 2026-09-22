import { test, expect, describe } from 'bun:test'
import { AUTO_ALLOW, preToolUseDecision, preToolUseHookOutput } from './gate'

describe('permission gate', () => {
  test('forces the permission callback for every tool that is not read-only', () => {
    for (const t of ['Bash', 'Write', 'Edit', 'WebFetch', 'Agent', 'AskUserQuestion', 'ExitPlanMode', 'mcp__x__y', 'PowerShell']) {
      expect(preToolUseDecision(t)).toBe('ask')
      const out = preToolUseHookOutput(t) as any
      expect(out.hookSpecificOutput.hookEventName).toBe('PreToolUse')
      expect(out.hookSpecificOutput.permissionDecision).toBe('ask')
    }
  })

  test('lets read-only tools through without a prompt', () => {
    for (const t of AUTO_ALLOW) {
      expect(preToolUseDecision(t)).toBe('pass')
      expect(preToolUseHookOutput(t)).toEqual({})
    }
    // the read-only list is exactly the documented one; a write tool never sneaks in
    expect(AUTO_ALLOW).toEqual(['Read', 'Glob', 'Grep', 'LS', 'NotebookRead', 'TodoWrite'])
  })
})
