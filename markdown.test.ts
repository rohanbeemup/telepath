import { test, expect, describe } from 'bun:test'
import { mdToTelegramHtml, chunkHtml, htmlToPlain } from './markdown'

// Three backticks, written as escapes. Spelled literally they appear in a regex
// below, where the lexer in the test-plan checker reads them as an unterminated
// template literal and skips the whole file — which silently turns off the
// plan/suite agreement check this suite is held by.
const F = '\x60\x60\x60'

// The job of the renderer is to make what Claude writes readable in a Telegram
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
      ['Field → Value', '<b>Version</b>: 1.0.352', '<b>Env</b>: devnet'].join('\n'),
    )
  })

  test('keeps both header labels on a two-column table', () => {
    // A 2-column table is not always key/value. When the columns are two states
    // ("Allowed | Forbidden"), dropping the headers leaves the reader unable to
    // tell which value is which, and the fallback never restores the meaning
    // because the HTML rendered successfully.
    const md = ['| Allowed | Forbidden |', '|---|---|', '| read | delete |'].join('\n')
    const out = mdToTelegramHtml(md)
    expect(out).toContain('Allowed')
    expect(out).toContain('Forbidden')
    expect(out).toContain('<b>read</b>: delete')
  })

  test('uses the header cells as labels in the order they appear', () => {
    const out = mdToTelegramHtml(NODES)
    expect(out.indexOf('Status: online')).toBeLessThan(out.indexOf('Uptime: 4d'))
    // The label belongs to its own column, not to the neighbouring one.
    expect(out).not.toContain('Uptime: online')
    expect(out).not.toContain('Status: 4d')
    // The header of column 1 is the row identity, not a label line of its own.
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
    const md = [F, 'ps aux | grep bun', '| not | a | table |', F].join('\n')
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
    // An already-bold title must not be wrapped a second time: the Telegram
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
      F,
      'code',
      F,
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

describe('chunking', () => {
  const F = '\x60\x60\x60'
  // Spelled without double quotes: an odd number of them inside a regex reads
  // as an unterminated string to the test-plan checker, which then skips the file.
  const hrefs = (h: string) => (h.match(/<a href=[^>]*>/g) ?? []).sort()
  // The daemon contract: parse the WHOLE message once, then split the output.
  const send = (md: string, limit = 3500) => chunkHtml(mdToTelegramHtml(md), limit)

  const fenced = (lines: number, extra: string, info = '') =>
    [F + info, ...Array.from({ length: lines }, (_, i) => `line ${i} of literal code inside a fence`), extra, F].join('\n')

  test('keeps a fenced code block inert when it spans a chunk boundary', () => {
    const parts = send(fenced(160, '[click here](https://evil.example/pwn)'))
    expect(parts.length).toBeGreaterThan(1)
    for (const part of parts) expect(part).not.toContain('<a href')
  })

  test('keeps literal content inert when a long line inside it ends in a fence marker', () => {
    // A hard split of this line used to manufacture a standalone closing fence.
    const md = [F, 'x'.repeat(3484) + F, '[click here](https://evil.example/pwn)', F].join('\n')
    expect(mdToTelegramHtml(md)).not.toContain('<a href')
    for (const part of send(md)) expect(part).not.toContain('<a href')
  })

  test('keeps a fenced block inside a blockquote inert when it is split', () => {
    const body = Array.from({ length: 120 }, (_, i) => `> line ${i} of quoted literal code`).join('\n')
    const md = ['> ' + F, body, '> [click here](https://evil.example/pwn)', '> ' + F].join('\n')
    expect(mdToTelegramHtml(md)).not.toContain('<a href')
    for (const part of send(md)) expect(part).not.toContain('<a href')
  })

  test('introduces no href that the whole-message render did not contain', () => {
    const cases = [
      fenced(160, '[click here](https://evil.example/pwn)'),
      [F, 'x'.repeat(3484) + F, '[a](https://evil.example/1)', F].join('\n'),
      ['A real [link](https://example.com/ok) in prose.', '', fenced(120, 'plain')].join('\n'),
    ]
    for (const md of cases) {
      const allowed = new Set(hrefs(mdToTelegramHtml(md)))
      for (const part of send(md, 1200)) {
        for (const h of hrefs(part)) expect(allowed.has(h)).toBe(true)
      }
    }
  })

  test('reopens an open tag in the next chunk and closes it in the emitted one', () => {
    const md = ['> ' + F, ...Array.from({ length: 200 }, (_, i) => `> quoted line ${i}`), '> ' + F].join('\n')
    const parts = send(md, 1500)
    expect(parts.length).toBeGreaterThan(1)
    for (const part of parts) {
      expect(part).toContain('<pre>')
      expect((part.match(/<pre>/g) ?? []).length).toBe((part.match(/<\/pre>/g) ?? []).length)
    }
  })

  test('splits long text at line boundaries', () => {
    const md = Array.from({ length: 300 }, (_, i) => `sentence number ${i} of ordinary prose`).join('\n')
    const parts = chunkHtml(mdToTelegramHtml(md), 1000)
    expect(parts.length).toBeGreaterThan(1)
    for (const p of parts) {
      expect(p.length).toBeLessThanOrEqual(1000)
      expect(p.startsWith('sentence number')).toBe(true)
      expect(p.endsWith('of ordinary prose')).toBe(true)
    }
  })

  test('degrades a link whose tag alone exceeds the budget to visible text', () => {
    const url = 'https://example.com/' + 'a'.repeat(5000)
    const parts = chunkHtml(mdToTelegramHtml(url), 3500)
    // The destination survives as readable text rather than being dropped.
    expect(parts.join('').replace(/<[^>]*>/g, '')).toContain('a'.repeat(200))
    for (const part of parts) expect(part).not.toContain('<a href')
  })

  test('keeps every chunk within the limit, even when one link is oversized', () => {
    const url = 'https://example.com/' + 'a'.repeat(5000)
    for (const limit of [500, 1200, 3500]) {
      for (const part of chunkHtml(mdToTelegramHtml(url), limit)) {
        expect(part.length).toBeLessThanOrEqual(limit)
      }
    }
  })

  test('does not split inside a tag or an entity', () => {
    // ONE long paragraph, so marked renders it as a single line and the splitter
    // has to cut inside it. Densely packed with tags and entities, which is where
    // an unchecked cut lands.
    const md = Array.from({ length: 60 }, (_, i) =>
      `row ${i} [label ${i}](https://example.com/a-fairly-long-path/${i}) with a&b and x<y,`).join(' ')
    for (const limit of [200, 333, 700, 1024]) {
      for (const part of chunkHtml(mdToTelegramHtml(md), limit)) {
        expect((part.match(/</g) ?? []).length).toBe((part.match(/>/g) ?? []).length)
        expect(part).not.toMatch(/&[a-zA-Z#0-9]{0,8}$/)
        expect(part).not.toMatch(/<[^>]*$/)
      }
    }
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

  test('does not emit a chunk Telegram would refuse', () => {
    const LIMIT = 3500
    const adversarial = [
      'https://example.com/' + 'a'.repeat(5000),
      '[label](https://example.com/' + 'b'.repeat(5000) + ')',
      'x'.repeat(9000),
      Array.from({ length: 40 }, (_, i) => `[l${i}](https://example.com/` + 'c'.repeat(300) + `/${i})`).join(' '),
    ]
    for (const md of adversarial) {
      const parts = chunkHtml(mdToTelegramHtml(md), LIMIT)
      expect(parts.length).toBeGreaterThan(0)
      for (const part of parts) {
        expect(part.length).toBeLessThanOrEqual(LIMIT)
        expect(htmlToPlain(part).length).toBeLessThanOrEqual(LIMIT)
      }
    }
  })

  test('does not leave an unbalanced tag in any chunk', () => {
    const Q = '\x60\x60\x60'
    const md = ['> ' + Q, ...Array.from({ length: 200 }, (_, i) => `> **bold ${i}** and text ${i}`), '> ' + Q].join('\n')
    for (const limit of [400, 800, 1500, 2600]) {
      for (const part of chunkHtml(mdToTelegramHtml(md), limit)) {
        for (const tag of ['b', 'i', 'code', 'pre', 'blockquote', 'a']) {
          const open = (part.match(new RegExp('<' + tag + '(?=[ >])', 'g')) ?? []).length
          const close = (part.match(new RegExp('</' + tag + '>', 'g')) ?? []).length
          expect(open).toBe(close)
        }
      }
    }
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
