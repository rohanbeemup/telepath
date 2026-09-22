/**
 * Activity feed: what a session is DOING, one short line per tool call.
 *
 * A topic in auto mode posts no approval prompts, and a model working through a long
 * autonomous task (Fable at high effort, background commands) can go an hour with a
 * single sentence of text. Measured on a real transcript: 277 tool calls, 1 text
 * block, in one hour — the topic showed only "Background task completed" notices.
 * The feed is the deterministic substitute for the running commentary the model
 * does not give: pure functions here, the batching and the toggle live in daemon.ts.
 */
import { basename } from 'path'

const MAX = 140

function oneLine(s: string, max = MAX): string {
  const t = s.replace(/\s*\n\s*/g, ' ').replace(/\s+/g, ' ').trim()
  return t.length > max ? t.slice(0, max - 1) + '…' : t
}

function fileName(p: unknown): string {
  return typeof p === 'string' && p ? basename(p.replace(/\\/g, '/')) : '?'
}

/** One phone-readable line for a tool call. Never the raw input. */
export function summarizeToolUse(name: string, input: Record<string, unknown> | undefined): string {
  const i = input ?? {}
  switch (name) {
    case 'Bash': {
      const what = typeof i.description === 'string' && i.description ? i.description : String(i.command ?? '')
      return oneLine(`🖥 ${what}${i.run_in_background ? ' ⏳' : ''}`)
    }
    case 'Read':
      return oneLine(`📖 ${fileName(i.file_path)}`)
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return oneLine(`✏️ ${fileName(i.file_path ?? i.notebook_path)}`)
    case 'Write':
      return oneLine(`📝 ${fileName(i.file_path)}`)
    case 'Grep':
    case 'Glob':
      return oneLine(`🔍 ${String(i.pattern ?? '')}`)
    case 'WebFetch':
      return oneLine(`🌐 ${String(i.url ?? '')}`)
    case 'WebSearch':
      return oneLine(`🌐 ${String(i.query ?? '')}`)
    case 'Agent':
    case 'Task':
      return oneLine(`🤖 ${String(i.description ?? i.prompt ?? '')}`)
    case 'AskUserQuestion':
    case 'ExitPlanMode':
    case 'EnterPlanMode':
    case 'TodoWrite':
      return oneLine(`📋 ${name}`)
    default: {
      let brief = ''
      try {
        brief = JSON.stringify(i)
      } catch {}
      return oneLine(`🔧 ${name} ${brief}`)
    }
  }
}

/** Feed lines for one assistant message's content blocks: tool calls only. */
export function feedLines(content: unknown): string[] {
  if (!Array.isArray(content)) return []
  return content
    .filter((b: any) => b?.type === 'tool_use')
    .map((b: any) => summarizeToolUse(String(b.name ?? '?'), b.input))
}

/**
 * One line for a task event the SDK reports itself: a subagent or background command
 * starting, or a background task settling. The start line is what lets a later
 * "done" line be read; without it the completion refers to nothing.
 */
export function describeTask(status: 'started' | 'completed' | 'failed' | 'stopped', description: string, background: boolean): string {
  const what = description || 'task'
  switch (status) {
    case 'started':
      return oneLine(`${background ? '⏳' : '🤖'} started: ${what}`)
    case 'completed':
      return oneLine(`✅ done: ${what}`)
    case 'failed':
      return oneLine(`❌ failed: ${what}`)
    case 'stopped':
      return oneLine(`⏹ stopped: ${what}`)
  }
}

/**
 * Batches feed lines per topic. A turn often fires several tools within a second and
 * Telegram allows a bot about twenty messages a minute per group, so lines wait a
 * short window and go out as one message. `flush` is injected: the batcher knows
 * nothing about Telegram, and a test reads what it would have sent.
 */
export class FeedBatcher {
  private readonly buf = new Map<string, { lines: string[]; timer: ReturnType<typeof setTimeout> }>()
  constructor(
    private readonly flush: (topicId: string, text: string) => void,
    private readonly windowMs = 2500,
    private readonly maxChars = 3900,
  ) {}

  add(topicId: string, lines: string[]): void {
    if (!lines.length) return
    const cur = this.buf.get(topicId)
    if (cur) {
      cur.lines.push(...lines)
      return
    }
    const timer = setTimeout(() => this.fire(topicId), this.windowMs)
    this.buf.set(topicId, { lines: [...lines], timer })
  }

  /** Send whatever is waiting for a topic now (used before a close). */
  fire(topicId: string): void {
    const b = this.buf.get(topicId)
    if (!b) return
    clearTimeout(b.timer)
    this.buf.delete(topicId)
    this.flush(topicId, b.lines.join('\n').slice(0, this.maxChars))
  }

  drop(topicId: string): void {
    const b = this.buf.get(topicId)
    if (!b) return
    clearTimeout(b.timer)
    this.buf.delete(topicId)
  }
}
