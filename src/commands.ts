/**
 * The typed-text grammar of a session topic. Everything that is not one of these is a
 * chat message for the session. Pure, so the grammar is tested without a bot.
 */
import { isModelKey, parseEffort, type Catalog, type Effort, type ModelKey } from './models'

export type Typed =
  | { kind: 'slash'; cmd: string; args: string }
  | { kind: 'use'; model: ModelKey; effort: Effort | undefined }
  | { kind: 'effort'; effort: Effort | undefined }
  | { kind: 'feed'; on: boolean }
  | { kind: 'wrap' }
  | { kind: 'chat'; text: string }

export function parseTyped(raw: string, catalog: Catalog): Typed {
  const text = raw.trim()
  if (text.startsWith('/')) {
    const [cmd, ...rest] = text.slice(1).split(/\s+/)
    return { kind: 'slash', cmd: cmd.toLowerCase(), args: rest.join(' ') }
  }
  const use = /^use\s+(\S+)(?:\s+(\S+))?$/i.exec(text)
  if (use) {
    const key = use[1].toLowerCase()
    const effort = use[2] ? parseEffort(use[2]) : undefined
    if (isModelKey(catalog, key) && (!use[2] || effort)) return { kind: 'use', model: key, effort }
  }
  const eff = /^effort\s+(\S+)$/i.exec(text)
  if (eff) {
    const w = eff[1].toLowerCase()
    if (w === 'default') return { kind: 'effort', effort: undefined }
    const effort = parseEffort(w)
    if (effort) return { kind: 'effort', effort }
  }
  const feed = /^feed\s+(on|off)$/i.exec(text)
  if (feed) return { kind: 'feed', on: feed[1].toLowerCase() === 'on' }
  if (/^(wrap\s*up|stop)$/i.test(text)) return { kind: 'wrap' }
  return { kind: 'chat', text }
}
