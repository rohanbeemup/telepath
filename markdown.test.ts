import { test, expect, describe } from 'bun:test'
import { mdToTelegramHtml } from './markdown'

// The renderer's job is to make what Claude writes readable in a Telegram
// message. Telegram wraps ordinary text but does NOT wrap <pre>, so a table
// left as a pipe grid becomes a horizontally-scrolling sliver on a phone.
// These cases pin the shape that replaced it: one labelled block per row.

const NODES = [
  '| Node | Status  | Uptime |',
  '|------|---------|--------|',
  '| 163  | online  | 4d     |',
  '| 166  | offline | 2h     |',
].join('\n')

const KV = [
  '| Field   | Value   |',
  '|---------|---------|',
  '| Version | 1.0.352 |',
  '| Env     | devnet  |',
].join('\n')

/** Every line that still looks like a pipe-delimited row of a grid. */
function gridRows(html: string): string[] {
  return html.split('\n').filter(l => /\S\s*\|\s*\S/.test(l))
}

describe('tables', () => {
  test('renders a multi-column table as one labelled block per row', () => {
    expect(mdToTelegramHtml(NODES)).toBe(
      [
        '▸ <b>163</b>',
        '  Status: online',
        '  Uptime: 4d',
        '',
        '▸ <b>166</b>',
        '  Status: offline',
        '  Uptime: 2h',
      ].join('\n'),
    )
  })

  test('collapses a two-column table to one line per row', () => {
    expect(mdToTelegramHtml(KV)).toBe(
      ['<b>Version</b>: 1.0.352', '<b>Env</b>: devnet'].join('\n'),
    )
  })

  test('uses the header cells as labels in the order they appear', () => {
    const out = mdToTelegramHtml(NODES)
    expect(out.indexOf('Status: online')).toBeLessThan(out.indexOf('Uptime: 4d'))
    // The label belongs to its own column, not to the neighbouring one.
    expect(out).not.toContain('Uptime: online')
    expect(out).not.toContain('Status: 4d')
    // Column 1's header is the row's identity, not a label line of its own.
    expect(out).not.toContain('Node: 163')
  })

  test('emits no pipe-joined grid for any table', () => {
    const wide = [
      '| a | b | c | d | e |',
      '|---|---|---|---|---|',
      '| 1 | 2 | 3 | 4 | 5 |',
      '| 6 | 7 | 8 | 9 | 0 |',
    ].join('\n')
    for (const md of [NODES, KV, wide]) {
      expect(gridRows(mdToTelegramHtml(md))).toEqual([])
    }
  })

  test('keeps a fenced code block that contains pipes verbatim', () => {
    const md = ['```', 'ps aux | grep bun', '| not | a | table |', '```'].join('\n')
    const out = mdToTelegramHtml(md)
    expect(out).toContain('<pre>')
    expect(out).toContain('ps aux | grep bun')
    expect(out).toContain('| not | a | table |')
  })

  test('keeps inline formatting inside table cells', () => {
    const md = [
      '| Node | Status |',
      '|------|--------|',
      '| **163** | `online` |',
    ].join('\n')
    const out = mdToTelegramHtml(md)
    expect(out).toContain('<code>online</code>')
    // An already-bold title must not be wrapped a second time: Telegram's
    // entity parser is the thing that rejects the message, and the fallback
    // would silently drop all formatting for that send.
    expect(out).toContain('<b>163</b>')
    expect(out).not.toContain('<b><b>')
  })

  test('escapes HTML special characters in cells exactly once', () => {
    const md = ['| Key | Value |', '|-----|-------|', '| a&b | x<y |'].join('\n')
    const out = mdToTelegramHtml(md)
    expect(out).toContain('a&amp;b')
    expect(out).toContain('x&lt;y')
    expect(out).not.toContain('&amp;amp;')
    expect(out).not.toContain('&amp;lt;')
  })

  test('drops empty cells instead of emitting a bare label', () => {
    const md = [
      '| Node | Status | Uptime |',
      '|------|--------|--------|',
      '| 163  |        | 4d     |',
    ].join('\n')
    const out = mdToTelegramHtml(md)
    expect(out).toContain('Uptime: 4d')
    expect(out).not.toContain('Status:')
    expect(out.split('\n')).not.toContain('  Status: ')
  })

  test('renders a table with a single data row', () => {
    const md = ['| Node | Status | Uptime |', '|---|---|---|', '| 163 | online | 4d |'].join('\n')
    expect(mdToTelegramHtml(md)).toBe(
      ['▸ <b>163</b>', '  Status: online', '  Uptime: 4d'].join('\n'),
    )
  })

  test('renders every table in a message and preserves surrounding prose order', () => {
    const md = ['before', '', NODES, '', 'between', '', KV, '', 'after'].join('\n')
    const out = mdToTelegramHtml(md)
    const at = (s: string) => out.indexOf(s)
    expect(at('before')).toBeGreaterThanOrEqual(0)
    expect(at('before')).toBeLessThan(at('▸ <b>163</b>'))
    expect(at('▸ <b>163</b>')).toBeLessThan(at('between'))
    expect(at('between')).toBeLessThan(at('<b>Version</b>: 1.0.352'))
    expect(at('<b>Version</b>: 1.0.352')).toBeLessThan(at('after'))
    expect(gridRows(out)).toEqual([])
  })

  test('still renders headings, lists, code and links as before', () => {
    const md = [
      '## Heading',
      '',
      '- one',
      '- two',
      '',
      '```',
      'code',
      '```',
      '',
      '[link](https://example.com)',
    ].join('\n')
    const out = mdToTelegramHtml(md)
    expect(out).toContain('<b>Heading</b>')
    expect(out).toContain('• one')
    expect(out).toContain('• two')
    expect(out).toContain('<pre>code</pre>')
    expect(out).toContain('<a href="https://example.com">link</a>')
  })
})

describe('tables (negative)', () => {
  test('does not wrap a table in a pre block', () => {
    for (const md of [NODES, KV]) {
      expect(mdToTelegramHtml(md)).not.toContain('<pre>')
    }
  })

  test('does not treat a paragraph containing pipes as a table', () => {
    const md = 'Run `ps aux | grep bun` to check, or a | b for the alternative.'
    const out = mdToTelegramHtml(md)
    expect(out).toContain('a | b for the alternative')
    expect(out).not.toContain('▸')
  })

  test('does not drop a row whose first cell is empty', () => {
    const md = [
      '| Node | Status | Uptime |',
      '|------|--------|--------|',
      '|      | online | 4d     |',
    ].join('\n')
    const out = mdToTelegramHtml(md)
    expect(out).toContain('Status: online')
    expect(out).toContain('Uptime: 4d')
  })
})
