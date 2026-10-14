/**
 * The focus tool (~/.claude/scripts/focus/focus.py), when one is installed: its gate view
 * before a new topic starts, and the marks a gate tap asks for.
 *
 * Optional the way src/rotator.ts is: the environment is read at call time (ES imports run
 * before daemon.ts merges the state directory's .env), nothing happens without the tool, and
 * every failure comes back as "no answer", so a new topic is never blocked by it.
 */
import { existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { parseGateView, type GateView } from './ui/focusgate'

export function focusCli(): string {
  return process.env.FOCUS_CLI || join(homedir(), '.claude', 'scripts', 'focus', 'focus.py')
}

/** The tool needs only the standard library; a bare `python` may be a shim into some virtualenv. */
export function focusPy(): string {
  return process.env.FOCUS_PY || '/usr/bin/python3'
}

/** A focus tool is installed and the gate is not switched off (`FOCUS_GATE=off`). */
export function focusEnabled(): boolean {
  return process.env.FOCUS_GATE !== 'off' && existsSync(focusCli())
}

/** `-I` keeps the tool's folder and the user's site-packages out of its import path. */
export function focusArgv(...args: string[]): string[] {
  return [focusPy(), '-I', focusCli(), ...args]
}

export type FocusRun = { ok: boolean; stdout: string; reason?: string }

/** Runs one tool command with a deadline. Never throws. */
export async function runFocus(argv: string[], timeoutMs = 3000): Promise<FocusRun> {
  let proc: ReturnType<typeof Bun.spawn>
  try {
    proc = Bun.spawn(argv, { stdout: 'pipe', stderr: 'ignore', stdin: 'ignore' })
  } catch (e) {
    return { ok: false, stdout: '', reason: `could not start: ${e instanceof Error ? e.message : String(e)}` }
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<'timeout'>(r => {
    timer = setTimeout(() => r('timeout'), timeoutMs)
  })
  const finished = (async () => {
    const stdout = await new Response(proc.stdout as ReadableStream).text()
    return { stdout, code: await proc.exited }
  })()
  const r = await Promise.race([finished, timedOut])
  clearTimeout(timer)
  if (r === 'timeout') {
    proc.kill()
    return { ok: false, stdout: '', reason: 'timeout' }
  }
  return r.code === 0 ? { ok: true, stdout: r.stdout } : { ok: false, stdout: r.stdout, reason: `exit ${r.code}` }
}

/** The tool's gate view, or a reason there is none. `argv` is for tests. */
export async function readGate(o: { argv?: string[]; timeoutMs?: number } = {}): Promise<{ view?: GateView; reason?: string }> {
  const r = await runFocus(o.argv ?? focusArgv('gate', '--json'), o.timeoutMs ?? 3000)
  if (!r.ok) return { reason: r.reason }
  const view = parseGateView(r.stdout)
  return view ? { view } : { reason: 'unreadable gate output' }
}

export async function markItem(num: number, state = 'parked'): Promise<boolean> {
  return (await runFocus(focusArgv('mark', String(num), state, '--by', 'telepath-gate'))).ok
}

export async function parkIdle(): Promise<boolean> {
  return (await runFocus(focusArgv('park-idle'))).ok
}
