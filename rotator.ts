/**
 * Hand-off to the claude-rotator (yom-ooo/claude-rotator), when one is installed.
 *
 * The rotator switches the shared `~/.claude/.credentials.json` between accounts when a
 * budget runs out. In VS Code it learns about budgets through a process-wrapper shim that
 * relays every `rate_limit_event` the CLI prints to `rotator.py limit-event --stdin`.
 * Sessions spawned by this daemon go straight to the claude binary, so nothing relays
 * their events: the rotator never sees the budget these topics burn on the shared
 * account, and after it switches accounts a live topic keeps its old claude process
 * (old token) until idle eviction — sitting out a reset the rotator had already solved.
 *
 * This module closes both gaps with the shim's own contract: payload over stdin, never
 * awaited, the same append-only event log, and a no-op when no rotator is installed.
 */
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

// Same overrides the shim honours, so one environment configures both. Read at call
// time, not at import: ES imports are evaluated before daemon.ts runs loadEnv(), so a
// module-level constant would only ever see the shell's environment and silently
// ignore anything set in the state directory's .env.
function accountsDir(): string {
  return process.env.CLAUDE_ROTATOR_HOME || join(homedir(), '.claude-accounts')
}
function script(): string {
  return process.env.CLAUDE_ROTATOR_SCRIPT || join(homedir(), '.claude-rotator', 'rotator.py')
}
function python(): string {
  return process.env.CLAUDE_ROTATOR_PY || 'python'
}

/** A rotator is installed and the hand-off is not switched off (`ROTATOR_HANDOFF=off`). */
export function rotatorEnabled(): boolean {
  return process.env.ROTATOR_HANDOFF !== 'off' && existsSync(script())
}

/** The account the rotator has connected, per its `.active` marker; undefined without one. */
export function rotatorActive(): string | undefined {
  try {
    return readFileSync(join(accountsDir(), '.active'), 'utf8').trim() || undefined
  } catch {
    return undefined
  }
}

/** One line in the shim's log format: `<UTC stamp, whole seconds> <raw JSON>`. */
export function limitEventLine(msg: unknown, now = new Date()): string {
  return `${now.toISOString().replace(/\.\d{3}Z$/, 'Z')} ${JSON.stringify(msg)}`
}

/** Relay a rate_limit_event to the rotator exactly as the shim does; fire-and-forget. */
export function handOffToRotator(msg: unknown): void {
  if (!rotatorEnabled()) return
  // The shim appends every event here too; the rotator's dashboard reads this log.
  try {
    appendFileSync(join(accountsDir(), 'limit-events.log'), limitEventLine(msg) + '\n')
  } catch {}
  try {
    const p = spawn(python(), [script(), 'limit-event', '--stdin'], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true })
    p.on('error', e => process.stderr.write(`[rotator] hand-off failed: ${e}\n`))
    p.stdin.on('error', () => {})
    p.stdin.end(JSON.stringify(msg))
    p.unref()
  } catch (e) {
    process.stderr.write(`[rotator] hand-off failed: ${e}\n`)
  }
}

/**
 * After a rejection the rotator decides within seconds. Poll the `.active` marker for a
 * change from `before`; resolve with the new account, or undefined when nothing changed
 * in time. The reader and timing are injectable so the test needs no rotator.
 */
export async function waitForRotation(
  before: string | undefined,
  opts: { attempts?: number; delayMs?: number; readActive?: () => string | undefined } = {},
): Promise<string | undefined> {
  const attempts = opts.attempts ?? 6
  const delayMs = opts.delayMs ?? 5000
  const readActive = opts.readActive ?? rotatorActive
  for (let i = 0; i < attempts; i++) {
    await new Promise(r => setTimeout(r, delayMs))
    const now = readActive()
    if (now && now !== before) return now
  }
  return undefined
}
