/**
 * The permission gate's first half: a PreToolUse hook decision.
 *
 * Measured against SDK 0.3.278: an allow rule in the user's `~/.claude/settings.json`
 * (or a bare `allowedTools` entry) approves a tool BEFORE `canUseTool` is consulted, so
 * a machine whose settings allow `Bash` would run every command with no Telegram prompt
 * at all. A PreToolUse hook answering `permissionDecision: 'ask'` forces the permission
 * prompt, which in SDK mode is the `canUseTool` callback — regardless of what the
 * settings files allow. Read-only tools pass through untouched.
 */

/** Read-only tools auto-run; everything else (Bash/Write/Edit/Web/Agent…) is gated. */
export const AUTO_ALLOW: readonly string[] = ['Read', 'Glob', 'Grep', 'LS', 'NotebookRead', 'TodoWrite']

export type GateDecision = 'pass' | 'ask'

export function preToolUseDecision(toolName: string): GateDecision {
  return AUTO_ALLOW.includes(toolName) ? 'pass' : 'ask'
}

/** The hook output for a decision; `{}` lets the permission system proceed as configured. */
export function preToolUseHookOutput(toolName: string): Record<string, unknown> {
  if (preToolUseDecision(toolName) === 'pass') return {}
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'ask',
      permissionDecisionReason: 'telepath: approval happens in Telegram',
    },
  }
}
