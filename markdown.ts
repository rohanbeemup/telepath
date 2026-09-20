import { marked } from 'marked'

// ── Markdown → Telegram HTML ────────────────────────────────────────────────
// Telegram renders a small HTML subset (b/i/s/code/pre/a). HTML only needs
// < > & escaped in text — far more robust than MarkdownV2's reserved-char
// minefield. Claude emits GitHub Markdown; we parse it with `marked` and map
// the tokens to that subset (headings→bold, lists→•, tables→monospace text).
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
        // mdInline() already escapes cell text; strip its inline tags and wrap
        // in <pre>. Do NOT htmlEsc again — that would double-escape (&amp;amp;).
        const row = (cells: any[]) => cells.map((c: any) => mdInline(c.tokens)).join(' | ')
        const lines = [row(t.header), ...t.rows.map((r: any) => row(r))]
        out += `<pre>${lines.join('\n').replace(/<\/?[^>]+>/g, '')}</pre>\n\n`
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
