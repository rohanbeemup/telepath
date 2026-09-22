import { test, expect, describe } from 'bun:test'
import { summarizeToolUse, feedLines, describeTask, FeedBatcher, packLines } from './feed'

describe('describeTask', () => {
  test('describes a started background task and a settled one', () => {
    expect(describeTask('started', 'Run the suite', true)).toBe('⏳ started: Run the suite')
    expect(describeTask('started', 'Audit the routes', false)).toBe('🤖 started: Audit the routes')
    expect(describeTask('completed', 'Run the suite', true)).toBe('✅ done: Run the suite')
    expect(describeTask('failed', 'Start the server', true)).toBe('❌ failed: Start the server')
    expect(describeTask('stopped', '', true)).toBe('⏹ stopped: task')
  })
})

describe('FeedBatcher', () => {
  test('batches lines within the window into one message per topic', async () => {
    const sent: [string, string][] = []
    const fb = new FeedBatcher((t, text) => void sent.push([t, text]), 15)
    fb.add('1', ['a'])
    fb.add('1', ['b', 'c'])
    fb.add('2', ['x'])
    fb.add('1', []) // nothing to add, nothing scheduled twice
    await new Promise(r => setTimeout(r, 60))
    expect(sent).toEqual([['1', 'a\nb\nc'], ['2', 'x']])
  })

  test('splits an oversized batch into several sends instead of truncating it', () => {
    const sent: string[] = []
    const fb = new FeedBatcher((_t, text) => void sent.push(text), 10_000, 50)
    const lines = Array.from({ length: 12 }, (_, i) => `line-${i}-${'x'.repeat(10)}`)
    fb.add('1', lines)
    fb.fire('1')
    expect(sent.length).toBeGreaterThan(1)
    for (const s of sent) expect(s.length).toBeLessThanOrEqual(50)
    expect(sent.join('\n').split('\n')).toEqual(lines) // every line arrives, in order
    expect(packLines(['a'.repeat(80)], 50)[0].length).toBe(50) // a single over-long line is capped, not dropped
  })

  test('fire sends what is waiting at once and drop discards it', async () => {
    const sent: string[] = []
    const fb = new FeedBatcher((_t, text) => void sent.push(text), 10_000)
    fb.add('1', ['now'])
    fb.fire('1')
    fb.add('1', ['never'])
    fb.drop('1')
    await new Promise(r => setTimeout(r, 20))
    expect(sent).toEqual(['now'])
  })
})

// The activity feed is what the user sees of a session that runs in auto mode
// and talks little: one line per tool call, readable on a phone, never a JSON dump.
describe('summarizeToolUse', () => {
  test('Bash prefers the human description over the command', () => {
    expect(summarizeToolUse('Bash', { command: 'pnpm test --filter web', description: 'Run the web unit tests' }))
      .toBe('🖥 Run the web unit tests')
  })

  test('Bash without a description shows the command, trimmed to one line', () => {
    expect(summarizeToolUse('Bash', { command: 'git status\n&& git diff --stat' })).toBe('🖥 git status && git diff --stat')
  })

  test('background Bash is marked, so a later "Background task completed" has a referent', () => {
    expect(summarizeToolUse('Bash', { command: 'pnpm dev', description: 'Start the dev server', run_in_background: true }))
      .toBe('🖥 Start the dev server ⏳')
  })

  test('file tools name the file, not the whole payload', () => {
    expect(summarizeToolUse('Read', { file_path: 'C:\\Bots\\x\\src\\app\\page.tsx' })).toBe('📖 page.tsx')
    expect(summarizeToolUse('Edit', { file_path: '/repo/src/lib/db.ts', old_string: 'a'.repeat(500), new_string: 'b' })).toBe('✏️ db.ts')
    expect(summarizeToolUse('Write', { file_path: '/repo/README.md', content: 'x'.repeat(9000) })).toBe('📝 README.md')
  })

  test('search tools show the pattern', () => {
    expect(summarizeToolUse('Grep', { pattern: 'TODO|FIXME', path: '/repo' })).toBe('🔍 TODO|FIXME')
    expect(summarizeToolUse('Glob', { pattern: '**/*.test.ts' })).toBe('🔍 **/*.test.ts')
  })

  test('subagents show their brief', () => {
    expect(summarizeToolUse('Agent', { description: 'Audit the auth routes', prompt: 'x'.repeat(4000) })).toBe('🤖 Audit the auth routes')
  })

  test('unknown tools fall back to name plus a short input', () => {
    const s = summarizeToolUse('mcp__foo__bar', { a: 1, b: 'x'.repeat(300) })
    expect(s.startsWith('🔧 mcp__foo__bar ')).toBe(true)
    expect(s.length).toBeLessThanOrEqual(140)
  })

  test('every line is single-line and capped', () => {
    const s = summarizeToolUse('Bash', { command: 'x'.repeat(1000) + '\n' + 'y'.repeat(1000) })
    expect(s.includes('\n')).toBe(false)
    expect(s.length).toBeLessThanOrEqual(140)
  })
})

describe('feedLines', () => {
  test('turns an assistant message into one line per tool call, nothing for text or thinking', () => {
    const content = [
      { type: 'thinking', thinking: '' },
      { type: 'text', text: 'Let me look.' },
      { type: 'tool_use', name: 'Read', input: { file_path: '/r/a.ts' } },
      { type: 'tool_use', name: 'Bash', input: { command: 'ls', description: 'List files' } },
    ]
    expect(feedLines(content)).toEqual(['📖 a.ts', '🖥 List files'])
  })

  test('a message without tool calls yields no lines', () => {
    expect(feedLines([{ type: 'text', text: 'done' }])).toEqual([])
    expect(feedLines(undefined)).toEqual([])
  })
})
