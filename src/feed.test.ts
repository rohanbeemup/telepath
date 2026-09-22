import { test, expect, describe } from 'bun:test'
import { toolItem, feedItems, describeTask, digest, FeedBatcher, packLines, type FeedItem } from './feed'

// The activity feed is what the user sees of a session that runs in auto mode and talks
// little. On a phone it must read as a digest, not as one message per file the machine
// touched: names of local files are not something the reader can act on.
describe('toolItem', () => {
  test('Bash prefers the human description over the command', () => {
    expect(toolItem('Bash', { command: 'pnpm test --filter web', description: 'Run the web unit tests' })).toEqual({ kind: 'command', label: 'Run the web unit tests', background: false })
  })

  test('Bash without a description shows the command, trimmed to one line', () => {
    expect(toolItem('Bash', { command: 'git status\n&& git diff --stat' }).label).toBe('git status && git diff --stat')
  })

  test('background Bash is marked, so a later "done" line has a referent', () => {
    expect(toolItem('Bash', { command: 'pnpm dev', description: 'Start the dev server', run_in_background: true }).background).toBe(true)
  })

  test('file tools name the file, not the whole payload', () => {
    expect(toolItem('Read', { file_path: 'C:\\Bots\\x\\src\\app\\page.tsx' })).toEqual({ kind: 'read', label: 'page.tsx' })
    expect(toolItem('Edit', { file_path: '/repo/src/lib/db.ts', old_string: 'a'.repeat(500), new_string: 'b' })).toEqual({ kind: 'edit', label: 'db.ts' })
    expect(toolItem('Write', { file_path: '/repo/README.md', content: 'x'.repeat(9000) })).toEqual({ kind: 'edit', label: 'README.md' })
  })

  test('search tools show the pattern', () => {
    expect(toolItem('Grep', { pattern: 'TODO|FIXME', path: '/repo' })).toEqual({ kind: 'search', label: 'TODO|FIXME' })
    expect(toolItem('Glob', { pattern: '**/*.test.ts' }).kind).toBe('search')
  })

  test('subagents show their brief', () => {
    expect(toolItem('Agent', { description: 'Audit the auth routes', prompt: 'x'.repeat(4000) })).toEqual({ kind: 'agent', label: 'Audit the auth routes' })
  })

  test('unknown tools fall back to name plus a short input', () => {
    const item = toolItem('mcp__foo__bar', { a: 1, b: 'x'.repeat(300) })
    expect(item.kind).toBe('other')
    expect(item.label.startsWith('mcp__foo__bar ')).toBe(true)
    expect(item.label.length).toBeLessThanOrEqual(100)
  })

  test('every label is single-line and capped', () => {
    const item = toolItem('Bash', { command: 'x'.repeat(1000) + '\n' + 'y'.repeat(1000) })
    expect(item.label.includes('\n')).toBe(false)
    expect(item.label.length).toBeLessThanOrEqual(160)
  })
})

describe('feedItems', () => {
  test('turns an assistant message into one item per tool call, nothing for text or thinking', () => {
    const content = [
      { type: 'thinking', thinking: '' },
      { type: 'text', text: 'Let me look.' },
      { type: 'tool_use', name: 'Read', input: { file_path: '/r/a.ts' } },
      { type: 'tool_use', name: 'Bash', input: { command: 'ls', description: 'List files' } },
    ]
    expect(feedItems(content).map(i => i.kind)).toEqual(['read', 'command'])
    expect(feedItems(content, true).every(i => i.sub)).toBe(true)
  })

  test('a message without tool calls yields no items', () => {
    expect(feedItems([{ type: 'text', text: 'done' }])).toEqual([])
    expect(feedItems(undefined)).toEqual([])
  })
})

describe('digest', () => {
  test('a digest lists commands and subagents, collapses edits into one line and counts reads', () => {
    const items: FeedItem[] = [
      { kind: 'read', label: 'a.ts' },
      { kind: 'read', label: 'b.ts' },
      { kind: 'command', label: 'Typecheck and run the unit tests' },
      { kind: 'edit', label: 'package.json' },
      { kind: 'edit', label: 'tsconfig.json' },
      { kind: 'edit', label: 'topics.ts' },
      { kind: 'edit', label: 'registry.ts' },
      { kind: 'edit', label: 'facts.ts' },
      { kind: 'search', label: 'TODO' },
      { kind: 'agent', label: 'Inspect PR #92 branch state', sub: false },
      { kind: 'command', label: 'Start the dev server', background: true, sub: true },
    ]
    expect(digest(items)).toEqual([
      '🖥 Typecheck and run the unit tests',
      '🤖 Inspect PR #92 branch state',
      '↳ 🖥 Start the dev server ⏳',
      '✏️ edited 5 files: package.json, tsconfig.json, topics.ts +2',
      '📖 2 reads · 🔍 1 search',
    ])
    expect(digest([])).toEqual([])
    expect(digest([{ kind: 'edit', label: 'one.ts' }])).toEqual(['✏️ edited one.ts'])
  })

  test('a digest never lists more than a handful of lines and says how many it left out', () => {
    const items: FeedItem[] = Array.from({ length: 12 }, (_, i) => ({ kind: 'command' as const, label: `cmd ${i}` }))
    const lines = digest(items)
    expect(lines.length).toBe(6)
    expect(lines[5]).toBe('… +7 more')
  })
})

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
  test('batches items within the window into one digest per topic', async () => {
    const sent: [string, string][] = []
    const fb = new FeedBatcher((t, text) => void sent.push([t, text]), 15)
    fb.add('1', [{ kind: 'edit', label: 'a.ts' }])
    fb.add('1', [{ kind: 'edit', label: 'b.ts' }, { kind: 'command', label: 'Run tests' }])
    fb.add('2', [{ kind: 'read', label: 'x' }])
    fb.add('1', []) // nothing to add, nothing scheduled twice
    await new Promise(r => setTimeout(r, 60))
    expect(sent).toEqual([
      ['1', '🖥 Run tests\n✏️ edited 2 files: a.ts, b.ts'],
      ['2', '📖 1 read'],
    ])
  })

  test('splits an oversized batch into several sends instead of truncating it', () => {
    const sent: string[] = []
    const fb = new FeedBatcher((_t, text) => void sent.push(text), 10_000, 50)
    fb.add('1', Array.from({ length: 4 }, (_, i) => ({ kind: 'command' as const, label: `command number ${i} ${'x'.repeat(20)}` })))
    fb.fire('1')
    expect(sent.length).toBeGreaterThan(1)
    for (const s of sent) expect(s.length).toBeLessThanOrEqual(50)
    expect(sent.join('\n').split('\n').length).toBe(4) // every line arrives
    expect(packLines(['a'.repeat(80)], 50)[0].length).toBe(50) // a single over-long line is capped, not dropped
  })

  test('fire sends what is waiting at once and drop discards it', async () => {
    const sent: string[] = []
    const fb = new FeedBatcher((_t, text) => void sent.push(text), 10_000)
    fb.add('1', [{ kind: 'command', label: 'now' }])
    fb.fire('1')
    fb.add('1', [{ kind: 'command', label: 'never' }])
    fb.drop('1')
    await new Promise(r => setTimeout(r, 20))
    expect(sent).toEqual(['🖥 now'])
  })
})
