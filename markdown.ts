import { marked } from 'marked'

// ── Markdown → Telegram HTML ────────────────────────────────────────────────
// Telegram renders a small HTML subset (b/i/s/code/pre/a). HTML only needs
// < > & escaped in text — far more robust than MarkdownV2's reserved-char
// minefield. Claude emits GitHub Markdown; we parse it with `marked` and map
// the tokens to that subset (headings→bold, lists→•, tables→labelled blocks).
export function htmlEsc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
// Inverse of htmlEsc + tag strip — used as a plain-text fallback when Telegram
// rejects an HTML message (unescape &amp; last so it doesn't double-decode).
export function htmlToPlain(s: string): string {
  return s
    .replace(/<\/?[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}
/**
 * Bold a rendered cell, unless it is already exactly one bold span. Nesting
 * <b> inside <b> risks Telegram's entity parser rejecting the message, and the
 * plain-text fallback would then strip formatting from the entire send.
 */
function bold(s: string): string {
  const already = s.startsWith('<b>') && s.indexOf('</b>') === s.length - 4
  return already ? s : `<b>${s}</b>`
}
function mdInline(tokens: any[]): string {
  if (!tokens) return ''
  return tokens
    .map((t: any) => {
      switch (t.type) {
        case 'strong': return `<b>${mdInline(t.tokens)}</b>`
        case 'em': return `<i>${mdInline(t.tokens)}</i>`
        case 'del': return `<s>${mdInline(t.tokens)}</s>`
        case 'codespan': return `<code>${htmlEsc(t.text)}</code>`
        case 'link': return `<a href="${htmlEsc(t.href)}">${mdInline(t.tokens) || htmlEsc(t.text)}</a>`
        case 'br': return '\n'
        case 'text': return t.tokens ? mdInline(t.tokens) : htmlEsc(t.text)
        default: return htmlEsc(t.raw ?? t.text ?? '')
      }
    })
    .join('')
}
function mdBlock(tokens: any[]): string {
  let out = ''
  for (const t of tokens as any[]) {
    switch (t.type) {
      case 'heading': out += `<b>${mdInline(t.tokens)}</b>\n\n`; break
      case 'paragraph': out += `${mdInline(t.tokens)}\n\n`; break
      case 'text': out += `${t.tokens ? mdInline(t.tokens) : htmlEsc(t.text)}\n`; break
      case 'code': out += `<pre>${htmlEsc(t.text)}</pre>\n\n`; break
      case 'blockquote': out += `<blockquote>${mdBlock(t.tokens).trim()}</blockquote>\n\n`; break
      case 'list':
        t.items.forEach((it: any, i: number) => {
          const marker = t.ordered ? `${(t.start || 1) + i}. ` : '• '
          out += `${marker}${mdBlock(it.tokens).trim()}\n`
        })
        out += '\n'
        break
      case 'table': {
        // Telegram wraps ordinary text but never <pre>, so a pipe grid becomes a
        // horizontally-scrolling sliver on a phone. Render one labelled block per
        // row instead: column 1 is the row's identity, every other column becomes
        // a "header: cell" line. Two-column tables are almost always key/value, so
        // they collapse to one line per row rather than doubling in length.
        // mdInline() already escapes cell text — do NOT htmlEsc again, that would
        // double-escape (&amp;amp;).
        const cell = (c: any) => mdInline(c.tokens).trim()
        const headers = (t.header as any[]).map(cell)
        const twoCol = headers.length === 2
        const blocks: string[] = []
        for (const r of t.rows as any[]) {
          const cells = (r as any[]).map(cell)
          if (twoCol) {
            const k = cells[0] ?? ''
            const v = cells[1] ?? ''
            if (!k && !v) continue
            blocks.push(!k ? v : !v ? bold(k) : `${bold(k)}: ${v}`)
            continue
          }
          const [title, ...rest] = cells
          // An empty cell carries no information; a bare "Status:" line is noise.
          const lines = rest.map((v, i) => (v ? `  ${headers[i + 1]}: ${v}` : '')).filter(Boolean)
          // A row with no identity still has its other columns worth keeping.
          if (title) lines.unshift(`▸ ${bold(title)}`)
          if (lines.length) blocks.push(lines.join('\n'))
        }
        // A two-column table is not always key/value: "Allowed | Forbidden" names
        // two states, and dropping the header row leaves the reader unable to tell
        // which value is which. One caption line keeps both labels without a
        // heuristic about what the headers "mean".
        if (twoCol && blocks.length && headers.some(Boolean)) {
          blocks.unshift(headers.filter(Boolean).join(' → '))
        }
        if (blocks.length) out += `${blocks.join(twoCol ? '\n' : '\n\n')}\n\n`
        break
      }
      case 'hr': out += '———\n\n'; break
      case 'space': break
      default: out += htmlEsc(t.raw ?? '')
    }
  }
  return out
}
export function mdToTelegramHtml(md: string): string {
  return mdBlock(marked.lexer(md)).replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * Split RENDERED HTML into sends that Telegram will accept.
 *
 * Splitting the markdown and parsing each piece is the design this replaces, and
 * it cannot be made safe. Any fragment gets reinterpreted, so a hard split of an
 * over-long line ending in a fence marker manufactures a closing fence, and a
 * fence inside a blockquote or a list is not a top-level fence at all. Both turn
 * content the author marked literal into an active link whose destination hides
 * behind its label, and because the result is valid HTML the caller's rejection
 * fallback never fires. Parsing the whole message once and splitting its OUTPUT
 * removes the class: a chunk of HTML is never parsed as markdown again.
 *
 * The split then has to respect HTML instead. It cuts only at points outside
 * every tag and entity, and any tag still open at the end of a chunk is closed
 * there and reopened at the start of the next, so each send stands alone.
 */
const TAG = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)[^>]*>/g

function tagName(tag: string): string {
  return (/^<\/?([a-zA-Z][a-zA-Z0-9]*)/.exec(tag) ?? ['', ''])[1]
}

/** The tag stack after `text` is appended to a chunk that already had `stack` open. */
function applyTags(stack: string[], text: string): string[] {
  const out = stack.slice()
  for (const m of text.matchAll(TAG)) {
    if (m[0].endsWith('/>')) continue
    if (m[1] === '/') {
      for (let i = out.length - 1; i >= 0; i--) {
        if (tagName(out[i]) === m[2]) { out.splice(i, 1); break }
      }
    } else {
      out.push(m[0])
    }
  }
  return out
}

function closeFor(stack: string[]): string {
  return stack.map(t => `</${tagName(t)}>`).reverse().join('')
}

/**
 * The largest index <= budget at which cutting lands outside every tag and entity.
 *
 * Only a window around the budget is examined. Scanning the whole remainder made
 * the cost of splitting grow with its square, and the caller runs synchronously
 * on the daemon's only thread. The window covers any tag or entity that starts
 * before the budget, since oversized tags are degraded to text before this runs.
 */
function safeCut(s: string, budget: number, window = 4096): number {
  if (budget >= s.length) budget = s.length
  if (s.length > budget + window) s = s.slice(0, budget + window)
  const unsafe = new Array(s.length + 1).fill(false)
  const mark = (re: RegExp) => {
    for (const m of s.matchAll(re)) {
      for (let i = m.index + 1; i < m.index + m[0].length; i++) unsafe[i] = true
    }
  }
  mark(/<[^>]*>/g)
  mark(/&[a-zA-Z#0-9]{1,10};/g)
  mark(/&[a-zA-Z#0-9]{0,10}$/g) // a truncated entity at the end is not a cut point either
  let cut = -1
  for (let i = Math.min(budget, s.length); i > 0; i--) if (!unsafe[i]) { cut = i; break }
  if (cut < 0) return -1
  for (let i = cut; i > cut - 200 && i > 1; i--) if (!unsafe[i] && /\s/.test(s[i - 1])) return i
  return cut
}

export function chunkHtml(html: string, limit = 3500): string[] {
  if (!html) return []
  if (html.length <= limit) return [html]

  // A tag can be longer than the budget on its own: marked autolinks a bare URL,
  // so 5000 characters of path become a 5000-character opening tag with nowhere
  // safe to cut. Overshooting is not the safe option, because Telegram refuses an
  // oversized message and the send is lost. Degrade the element to visible text
  // instead, keeping the destination the reader was shown and, since it is now
  // ordinary text, splittable.
  const maxTag = Math.max(64, Math.floor(limit / 4))
  html = html.replace(/<a ([^>]*)>([\s\S]*?)<\/a>/g, (whole, attrs, inner) => {
    if (whole.length - inner.length <= maxTag) return whole
    const href = (/href="([^"]*)"/.exec(attrs) ?? ['', ''])[1]
    if (!inner || inner === href) return inner || href
    return `${inner} (${href})`
  })

  const out: string[] = []
  let stack: string[] = []
  let cur = ''
  let filled = false // cur holds content, not just a reopened tag prefix

  /** What carrying this stack across a boundary costs: reopen it, then close it. */
  const overhead = (st: string[]) => st.join('').length + closeFor(st).length

  const flush = () => {
    if (!filled) return
    out.push(cur + closeFor(stack))
    // Formatting that costs more than half the budget cannot be carried. With 150
    // nested blockquotes the reopen prefix plus closing tags exceed a whole chunk,
    // so no content would ever fit and the split could not advance. Close it here
    // and continue unformatted: a degraded quote beats a daemon that stops
    // answering every topic.
    if (overhead(stack) > limit / 2) stack = []
    cur = stack.join('')
    filled = false
  }
  const add = (piece: string, sep: boolean) => {
    cur += (sep && filled ? '\n' : '') + piece
    stack = applyTags(stack, piece)
    filled = true
  }
  /**
   * Does `piece` still fit once we close whatever is open AFTER adding it? The
   * tags the piece itself opens are the ones an earlier version missed, which is
   * how a chunk could overshoot and how the loop could stop making progress.
   */
  const fits = (piece: string, sep: boolean) => {
    const base = cur.length + (sep && filled ? 1 : 0) + piece.length
    // Decide the hopeless case without walking the piece for tags: the remainder
    // is passed here first, and scanning it every time is what made this
    // quadratic.
    if (base > limit) return false
    return base + closeFor(applyTags(stack, piece)).length <= limit
  }

  for (const line of html.split('\n')) {
    let rest = line
    let first = true
    for (;;) {
      if (fits(rest, first)) { add(rest, first); break }
      if (filled) { flush(); first = true; continue }

      // Shrink the candidate until it fits with its own closing tags.
      let piece = ''
      let hi = Math.min(rest.length, limit)
      while (hi > 0) {
        const cut = safeCut(rest, hi)
        if (cut <= 0) break
        const cand = rest.slice(0, cut)
        if (fits(cand, first)) { piece = cand; break }
        hi = Math.min(cut - 1, Math.floor(hi * 0.9))
      }
      if (!piece) {
        // Nothing cuts safely: drop this line's markup and split it as the
        // escaped text it already is.
        const bare = rest.replace(/<[^>]*>/g, '')
        if (bare.length < rest.length) { rest = bare; continue }
        // Last resort. Always at least one character, so the loop advances.
        piece = rest.slice(0, Math.max(1, limit - overhead(stack) - cur.length))
      }
      add(piece, first)
      rest = rest.slice(piece.length)
      flush()
      first = true
      if (!rest) break
    }
  }
  flush()
  return out.filter(c => c.replace(/<[^>]*>/g, '').trim().length > 0)
}
