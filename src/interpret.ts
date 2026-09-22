/**
 * SDK message → events. This is the pump's judgement, kept pure: it decides what a
 * message means for the topic (say this, show that, alert, record) and nothing about
 * how it is delivered. The bot maps events to Telegram calls; tests feed messages in
 * and read events out, with no process and no network.
 */
import { feedLines, describeTask } from './feed'

export type Event =
  | { kind: 'say'; text: string }
  | { kind: 'feed'; lines: string[] }
  | { kind: 'sessionId'; id: string }
  /** Every rate-limit event, for the rotator hand-off (it judges thresholds itself). */
  | { kind: 'limitRelay'; raw: unknown }
  /** A hard rejection, once per turn. */
  | { kind: 'rateLimitHit'; resetsAt?: number }
  | { kind: 'turnEnd'; costUsd?: number; durationMs?: number; afterRateLimit: boolean }
  | { kind: 'turnError'; subtype: string; errors: string[]; afterRateLimit: boolean }
  | { kind: 'task'; status: 'started' | 'completed' | 'failed' | 'stopped'; description: string; background: boolean }
  | { kind: 'denied'; tool: string; message: string }
  | { kind: 'assistantError'; error: string }
  | { kind: 'state'; state: 'idle' | 'running' | 'requires_action' }

/** Per live session. `alerted` is the once-per-turn latch for rate-limit alerts. */
export type PumpState = { sessionId?: string; alerted: boolean }

export function newPumpState(sessionId: string | undefined): PumpState {
  return { sessionId, alerted: false }
}

export type InterpretOptions = { feed: boolean }

export function interpret(msg: any, st: PumpState, opts: InterpretOptions): Event[] {
  const out: Event[] = []
  if (!msg || typeof msg !== 'object') return out

  // Capture the session id only once a turn has produced output (assistant/result),
  // which guarantees a transcript exists on disk. An id taken from `init` for a session
  // closed before its first turn is dead and fails every later resume.
  if ((msg.type === 'assistant' || msg.type === 'result') && typeof msg.session_id === 'string' && !st.sessionId) {
    st.sessionId = msg.session_id
    out.push({ kind: 'sessionId', id: msg.session_id })
  }

  switch (msg.type) {
    case 'assistant': {
      const content = msg.message?.content
      if (typeof msg.error === 'string') out.push({ kind: 'assistantError', error: msg.error })
      const text = Array.isArray(content)
        ? content.filter((b: any) => b?.type === 'text').map((b: any) => String(b.text ?? '')).join('').trim()
        : ''
      if (text) out.push({ kind: 'say', text })
      if (opts.feed) {
        const lines = feedLines(content)
        if (lines.length) out.push({ kind: 'feed', lines: msg.parent_tool_use_id ? lines.map(s => '  ↳ ' + s) : lines })
      }
      return out
    }
    case 'rate_limit_event': {
      const info = msg.rate_limit_info ?? {}
      out.push({ kind: 'limitRelay', raw: msg })
      if (info.status === 'rejected' && !st.alerted) {
        st.alerted = true
        out.push({ kind: 'rateLimitHit', resetsAt: typeof info.resetsAt === 'number' ? info.resetsAt : undefined })
      }
      return out
    }
    case 'result': {
      const afterRateLimit = st.alerted
      st.alerted = false // a stale latch would silence every later turn's error notice
      if (msg.subtype === 'success' && !msg.is_error) {
        out.push({ kind: 'turnEnd', costUsd: msg.total_cost_usd, durationMs: msg.duration_ms, afterRateLimit })
      } else {
        const errors = Array.isArray(msg.errors) ? msg.errors.map(String) : typeof msg.result === 'string' && msg.result ? [msg.result] : []
        out.push({ kind: 'turnError', subtype: String(msg.subtype ?? 'error'), errors, afterRateLimit })
      }
      return out
    }
    case 'system': {
      switch (msg.subtype) {
        case 'task_notification':
          out.push({ kind: 'task', status: taskStatus(msg.status), description: String(msg.summary ?? ''), background: true })
          return out
        case 'task_started':
          out.push({ kind: 'task', status: 'started', description: String(msg.description ?? ''), background: !!msg.is_backgrounded })
          return out
        case 'permission_denied':
          out.push({ kind: 'denied', tool: String(msg.tool_name ?? '?'), message: String(msg.message ?? '') })
          return out
        case 'session_state_changed':
          if (msg.state === 'idle' || msg.state === 'running' || msg.state === 'requires_action') out.push({ kind: 'state', state: msg.state })
          return out
        default:
          return out
      }
    }
    default:
      return out
  }
}

function taskStatus(s: unknown): 'completed' | 'failed' | 'stopped' {
  return s === 'failed' ? 'failed' : s === 'stopped' ? 'stopped' : 'completed'
}

/** One feed line for a task event, or a notice line for a settled background task. */
export function taskLine(ev: Extract<Event, { kind: 'task' }>): string {
  return describeTask(ev.status, ev.description, ev.background)
}
