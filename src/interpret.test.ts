import { test, expect, describe } from 'bun:test'
import { interpret, newPumpState, type Event } from './interpret'

const feedOn = { feed: true }
const feedOff = { feed: false }

function assistant(content: unknown[], extra: Record<string, unknown> = {}) {
  return { type: 'assistant', message: { role: 'assistant', content }, parent_tool_use_id: null, session_id: 's1', uuid: 'u', ...extra }
}
function kinds(evs: Event[]): string[] {
  return evs.map(e => e.kind)
}

describe('interpret', () => {
  test('assistant text becomes one say event', () => {
    const st = newPumpState('s1')
    const evs = interpret(assistant([{ type: 'thinking', thinking: '' }, { type: 'text', text: 'Hello ' }, { type: 'text', text: 'there.' }]), st, feedOff)
    expect(evs).toEqual([{ kind: 'say', text: 'Hello there.' }])
  })

  test('tool calls become feed lines and subagent calls are indented', () => {
    const st = newPumpState('s1')
    const main = interpret(assistant([{ type: 'tool_use', name: 'Read', input: { file_path: '/r/a.ts' } }]), st, feedOn)
    expect(main).toEqual([{ kind: 'feed', lines: ['📖 a.ts'] }])
    const sub = interpret(assistant([{ type: 'tool_use', name: 'Read', input: { file_path: '/r/b.ts' } }], { parent_tool_use_id: 'tu1' }), st, feedOn)
    expect(sub).toEqual([{ kind: 'feed', lines: ['  ↳ 📖 b.ts'] }])
    expect(interpret(assistant([{ type: 'tool_use', name: 'Read', input: { file_path: '/r/a.ts' } }]), st, feedOff)).toEqual([])
  })

  test('captures the session id on the first assistant or result, never on init', () => {
    const st = newPumpState(undefined)
    expect(interpret({ type: 'system', subtype: 'init', session_id: 'fresh' }, st, feedOff)).toEqual([])
    expect(st.sessionId).toBeUndefined()
    const evs = interpret(assistant([{ type: 'text', text: 'hi' }], { session_id: 'fresh' }), st, feedOff)
    expect(evs[0]).toEqual({ kind: 'sessionId', id: 'fresh' })
    expect(st.sessionId).toBe('fresh')
    // second time: no repeat
    expect(kinds(interpret(assistant([{ type: 'text', text: 'again' }], { session_id: 'fresh' }), st, feedOff))).toEqual(['say'])
  })

  test('a rejected rate limit yields one rate-limit event and later allowed events yield none', () => {
    const st = newPumpState('s1')
    const rejected = { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1790000000 } }
    const allowed = { type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } }
    const warn = { type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning' } }
    expect(kinds(interpret(rejected, st, feedOff))).toEqual(['limitRelay', 'rateLimitHit'])
    expect(kinds(interpret(allowed, st, feedOff))).toEqual(['limitRelay'])
    expect(kinds(interpret(warn, st, feedOff))).toEqual(['limitRelay'])
  })

  test('does not repeat the rate-limit alert twice in one turn', () => {
    const st = newPumpState('s1')
    const rejected = { type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } }
    interpret(rejected, st, feedOff)
    expect(kinds(interpret(rejected, st, feedOff))).toEqual(['limitRelay'])
  })

  test('resets the rate-limit alert at the end of the turn', () => {
    const st = newPumpState('s1')
    const rejected = { type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } }
    interpret(rejected, st, feedOff)
    interpret({ type: 'result', subtype: 'success', is_error: false, session_id: 's1' }, st, feedOff)
    expect(kinds(interpret(rejected, st, feedOff))).toEqual(['limitRelay', 'rateLimitHit'])
  })

  test('a non-success result yields a turn-error event and success yields a quiet turn-end', () => {
    const st = newPumpState('s1')
    const ok = interpret({ type: 'result', subtype: 'success', is_error: false, session_id: 's1', total_cost_usd: 0.12, duration_ms: 900 }, st, feedOff)
    expect(ok).toEqual([{ kind: 'turnEnd', costUsd: 0.12, durationMs: 900, afterRateLimit: false }])
    const bad = interpret({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['boom'], session_id: 's1' }, st, feedOff)
    expect(bad).toEqual([{ kind: 'turnError', subtype: 'error_during_execution', errors: ['boom'], afterRateLimit: false }])
    // a success flagged is_error is still an error
    const flagged = interpret({ type: 'result', subtype: 'success', is_error: true, result: 'API Error 400', session_id: 's1' }, st, feedOff)
    expect(flagged[0].kind).toBe('turnError')
  })

  test('a background task notice carries status and summary', () => {
    const st = newPumpState('s1')
    const evs = interpret({ type: 'system', subtype: 'task_notification', status: 'failed', summary: 'Start the server', task_id: 't1' }, st, feedOff)
    expect(evs).toEqual([{ kind: 'task', status: 'failed', description: 'Start the server', background: true }])
  })

  test('a task_started event announces a background task once', () => {
    const st = newPumpState('s1')
    const started = { type: 'system', subtype: 'task_started', task_id: 't1', description: 'Run the suite', is_backgrounded: true }
    expect(interpret(started, st, feedOn)).toEqual([{ kind: 'task', status: 'started', description: 'Run the suite', background: true }])
    // foreground subagent start is feed material, not a notice
    const fg = { type: 'system', subtype: 'task_started', task_id: 't2', description: 'Audit', is_backgrounded: false, subagent_type: 'Explore' }
    expect(interpret(fg, st, feedOn)).toEqual([{ kind: 'task', status: 'started', description: 'Audit', background: false }])
  })

  test('permission_denied surfaces as a notice', () => {
    const st = newPumpState('s1')
    expect(interpret({ type: 'system', subtype: 'permission_denied', tool_name: 'Bash', message: 'blocked by policy' }, st, feedOff)).toEqual([
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
      expect(interpret(m, st, feedOff)).toEqual([])
    }
  })
})
