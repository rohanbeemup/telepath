import { test, expect, describe } from 'bun:test'
import { toolItem, feedItems, describeTask, digest, redactSecrets, type FeedItem } from './feed'

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

  test('labels never leak obvious secrets', () => {
    const cases: [string, string][] = [
      ['curl -H "Authorization: Bearer abcdef123456" https://x', 'curl -H "Authorization: [redacted]" https://x'],
      // a made-up shape only: a real-looking glsa_ token trips GitHub push protection
      ['TOKEN=glsa_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE ./deploy', 'TOKEN=[redacted] ./deploy'],
      ['export API_KEY=sk-live-0123456789abcdef && run', 'export API_KEY=[redacted] && run'],
      ['git push https://ghp_abcdefghijklmnopqrstuvwxyz1234@github.com/x', 'git push https://[redacted]@github.com/x'],
      ['curl https://api.telegram.org/bot123456789:AAEvh1-6FH_kTbYsSGjnb0np96APObjpXy0/getMe', 'curl https://api.telegram.org/bot[redacted]/getMe'],
    ]
    for (const [input, expected] of cases) expect(redactSecrets(input)).toBe(expected)
    // a git sha and a device id are identifiers, not secrets: they keep their face
    expect(redactSecrets('git show f6f7e9d0c1fb5fa1789ebe7867d2f4e3a1b2c3d4')).toBe('git show f6f7e9d0c1fb5fa1789ebe7867d2f4e3a1b2c3d4')
    // the redaction applies to command labels and to the fallback for unknown tools
    expect(toolItem('Bash', { command: 'curl -H "Authorization: Bearer abcdef123456" https://x' }).label).toContain('[redacted]')
    expect(toolItem('mcp__x__y', { password: 'hunter22' }).label).toContain('[redacted]')
    // a description written by the model is shown as-is: it is prose, not a command
    expect(toolItem('Bash', { command: 'x', description: 'Rotate the token' }).label).toBe('Rotate the token')
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
