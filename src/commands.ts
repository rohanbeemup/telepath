/**
 * The typed-text grammar of a session topic. Everything that is not one of these is a
 * chat message for the session. Pure, so the grammar is tested without a bot.
 */
import { isModelKey, parseEffort, type Catalog, type Effort, type ModelKey } from './models'

export type Typed =
  | { kind: 'slash'; cmd: string; args: string }
  /** A command addressed to another bot (`/new@other_bot`): nothing for this one to do. */
  | { kind: 'foreign' }
  | { kind: 'use'; model: ModelKey; effort: Effort | undefined }
  | { kind: 'effort'; effort: Effort | undefined }
  | { kind: 'feed'; on: boolean }
  | { kind: 'wrap' }
  | { kind: 'chat'; text: string }

/**
 * The slash commands this bot answers, with the line the published menu shows. One
 * table: the gate, the handler's switch and setMyCommands all read it, so a command
 * added to one cannot be missing from another.
 */
export const COMMANDS: Readonly<Record<string, string>> = {
  new: 'Start a new topic: /new <title>',
  list: 'Your sessions as buttons',
  attach: 'Bind an existing session: /attach <short-id> [name]',
  auto: 'Toggle auto mode in this topic',
  status: 'Live sessions, counters, versions',
  menu: 'Open the menu — everything is buttons',
  help: 'Show help',
}
export const KNOWN_COMMANDS: ReadonlySet<string> = new Set(Object.keys(COMMANDS))

export function parseTyped(raw: string, catalog: Catalog, botUsername?: string): Typed {
  const text = raw.trim()
  if (text.startsWith('/')) {
    const [word, ...rest] = text.slice(1).split(/\s+/)
    const at = word.indexOf('@')
    if (at >= 0) {
      // A command tapped from a group's menu arrives as /new@bot_name. Ours when the handle
      // is ours; another bot's otherwise, and not a command here at all.
      const handle = word.slice(at + 1).toLowerCase()
      if (!botUsername || handle !== botUsername.toLowerCase()) return { kind: 'foreign' }
      return { kind: 'slash', cmd: word.slice(0, at).toLowerCase(), args: rest.join(' ') }
    }
    return { kind: 'slash', cmd: word.toLowerCase(), args: rest.join(' ') }
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
