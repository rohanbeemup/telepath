import { test, expect, describe } from 'bun:test'
import { interpret, newPumpState, type Event } from './interpret'


function assistant(content: unknown[], extra: Record<string, unknown> = {}) {
  return { type: 'assistant', message: { role: 'assistant', content }, parent_tool_use_id: null, session_id: 's1', uuid: 'u', ...extra }
}
function kinds(evs: Event[]): string[] {
  return evs.map(e => e.kind)
}

describe('interpret', () => {
  test('assistant text becomes one say event', () => {
    const st = newPumpState('s1')
    const evs = interpret(assistant([{ type: 'thinking', thinking: '' }, { type: 'text', text: 'Hello ' }, { type: 'text', text: 'there.' }]), st)
    expect(evs).toEqual([{ kind: 'say', text: 'Hello there.' }])
  })

  test('tool calls become feed items and subagent calls are marked', () => {
    const st = newPumpState('s1')
    const main = interpret(assistant([{ type: 'tool_use', name: 'Read', input: { file_path: '/r/a.ts' } }]), st)
    expect(main).toEqual([{ kind: 'feed', items: [{ kind: 'read', label: 'a.ts' }] }])
    const sub = interpret(assistant([{ type: 'tool_use', name: 'Read', input: { file_path: '/r/b.ts' } }], { parent_tool_use_id: 'tu1' }), st)
    expect(sub).toEqual([{ kind: 'feed', items: [{ kind: 'read', label: 'b.ts', sub: true }] }])
    // items are emitted unconditionally: the status counts tool calls from them even
    // when the feed toggle hides the list, so a tool-using turn is never "quiet"
    expect(interpret(assistant([{ type: 'tool_use', name: 'Read', input: { file_path: '/r/a.ts' } }]), st).length).toBe(1)
  })

  test('captures the session id on the first assistant or result, never on init', () => {
    const st = newPumpState(undefined)
    expect(interpret({ type: 'system', subtype: 'init', session_id: 'fresh' }, st)).toEqual([])
    expect(st.sessionId).toBeUndefined()
    const evs = interpret(assistant([{ type: 'text', text: 'hi' }], { session_id: 'fresh' }), st)
    expect(evs[0]).toEqual({ kind: 'sessionId', id: 'fresh' })
    expect(st.sessionId).toBe('fresh')
    // second time: no repeat
    expect(kinds(interpret(assistant([{ type: 'text', text: 'again' }], { session_id: 'fresh' }), st))).toEqual(['say'])
  })

  test('a rejected rate limit yields one rate-limit event and later allowed events yield none', () => {
    const st = newPumpState('s1')
    const rejected = { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1790000000 } }
    const allowed = { type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } }
    const warn = { type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning' } }
    // the hit precedes the relay, so its handler captures the rotator baseline before the hand-off can move it
    expect(kinds(interpret(rejected, st))).toEqual(['rateLimitHit', 'limitRelay'])
    expect(kinds(interpret(allowed, st))).toEqual(['limitRelay'])
    expect(kinds(interpret(warn, st))).toEqual(['limitRelay'])
  })

  test('does not repeat the rate-limit alert twice in one turn', () => {
    const st = newPumpState('s1')
    const rejected = { type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } }
    interpret(rejected, st)
    expect(kinds(interpret(rejected, st))).toEqual(['limitRelay'])
  })

  test('resets the rate-limit alert at the end of the turn', () => {
    const st = newPumpState('s1')
    const rejected = { type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } }
    interpret(rejected, st)
    interpret({ type: 'result', subtype: 'success', is_error: false, session_id: 's1' }, st)
    expect(kinds(interpret(rejected, st))).toEqual(['rateLimitHit', 'limitRelay'])
  })

  test('a non-success result yields a turn-error event and success yields a quiet turn-end', () => {
    const st = newPumpState('s1')
    const ok = interpret({ type: 'result', subtype: 'success', is_error: false, session_id: 's1', total_cost_usd: 0.12, duration_ms: 900 }, st)
    expect(ok).toEqual([{ kind: 'turnEnd', costUsd: 0.12, durationMs: 900, afterRateLimit: false }])
    const bad = interpret({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['boom'], session_id: 's1' }, st)
    expect(bad).toEqual([{ kind: 'turnError', subtype: 'error_during_execution', errors: ['boom'], afterRateLimit: false }])
    // a success flagged is_error is still an error
    const flagged = interpret({ type: 'result', subtype: 'success', is_error: true, result: 'API Error 400', session_id: 's1' }, st)
    expect(flagged[0].kind).toBe('turnError')
  })

  test('a background task notice carries status and summary', () => {
    const st = newPumpState('s1')
    const evs = interpret({ type: 'system', subtype: 'task_notification', status: 'failed', summary: 'Start the server', task_id: 't1' }, st)
    expect(evs).toEqual([{ kind: 'task', status: 'failed', description: 'Start the server', background: true }])
  })

  test('a task_started event announces a background task once', () => {
    const st = newPumpState('s1')
    const started = { type: 'system', subtype: 'task_started', task_id: 't1', description: 'Run the suite', is_backgrounded: true }
    expect(interpret(started, st)).toEqual([{ kind: 'task', status: 'started', description: 'Run the suite', background: true }])
    // foreground subagent start is feed material, not a notice
    const fg = { type: 'system', subtype: 'task_started', task_id: 't2', description: 'Audit', is_backgrounded: false, subagent_type: 'Explore' }
    expect(interpret(fg, st)).toEqual([{ kind: 'task', status: 'started', description: 'Audit', background: false }])
  })

  test('permission_denied surfaces as a notice', () => {
    const st = newPumpState('s1')
    expect(interpret({ type: 'system', subtype: 'permission_denied', tool_name: 'Bash', message: 'blocked by policy' }, st)).toEqual([
      { kind: 'denied', tool: 'Bash', message: 'blocked by policy' },
    ])
  })

  test('unknown message types yield nothing', () => {
    const st = newPumpState('s1')
    for (const m of [
      { type: 'stream_event', event: {} },
      { type: 'tool_use_summary', summary: 'read three files' },
      { type: 'system', subtype: 'status', status: 'compacting' },
      { type: 'system', subtype: 'thinking_tokens' },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result' }] } },
      { type: 'made_up' },
    ]) {
      expect(interpret(m, st)).toEqual([])
    }
  })
})
