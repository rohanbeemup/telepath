/**
 * Every keyboard and panel text, as pure builders over grammy's InlineKeyboard (a data
 * structure, not a network client). Callback data stays under Telegram's 64-byte cap by
 * construction: keys and short tokens, never model ids or titles.
 */
import { InlineKeyboard } from 'grammy'
import { EFFORT_LEVELS, EFFORT_MENU, MODEL_MENU, modelLabel, modelLines, supportsEffort, type Catalog, type Effort } from '../models'
import { feedOn, type Binding, type Prefs } from '../state'

export const PAGE_SIZE = 10

export function mainMenuKb(): InlineKeyboard {
  return new InlineKeyboard()
    .text('🆕 New session', 'm:new').text('⚡ Quick new', 'm:quick').row()
    .text('📋 My sessions', 'm:list').text('▶️ Resume last', 'm:resume').row()
    .text('⚙️ Settings', 'm:settings').text('📊 Status', 'm:status').row()
    .text('❓ Help', 'm:help')
}

export const backKb = (): InlineKeyboard => new InlineKeyboard().text('⬅️ Back', 'm:menu')

/** Deep link to a forum topic: t.me/c/<id-without-100>/<topicId>. */
export function topicUrl(forumChatId: string, topicId: string): string {
  return `https://t.me/c/${forumChatId.replace(/^-100/, '')}/${topicId}`
}
export const openLinkKb = (forumChatId: string, topicId: string): InlineKeyboard =>
  new InlineKeyboard().url('➡️ Go to topic', topicUrl(forumChatId, topicId)).row().text('⬅️ Back', 'm:menu')

/** Two rows of effort buttons (low/med/high, xhigh/max/default) with ✓ on the active one. */
export function effortRows(kb: InlineKeyboard, current: Effort | undefined, ns: string): void {
  EFFORT_LEVELS.forEach((e, i) => {
    kb.text(`🎚 ${EFFORT_MENU[e].short}${current === e ? ' ✓' : ''}`, `m:${ns}:${e}`)
    if (i === 2) kb.row()
  })
  kb.text(`↺ default${current ? '' : ' ✓'}`, `m:${ns}:auto`).row()
}

export function settingsKb(c: Catalog, prefs: Prefs): InlineKeyboard {
  const kb = new InlineKeyboard()
  c.enabled.forEach((k, i) => {
    kb.text(`${MODEL_MENU[k].short}${prefs.defaultModel === c.ids[k] ? ' ✓' : ''}`, `m:sdm:${k}`)
    if (i % 2 === 1) kb.row()
  })
  if (c.enabled.length % 2 === 1) kb.row()
  effortRows(kb, prefs.defaultEffort, 'sde')
  return kb.text('📁 Default folder', 'm:sdf').row().text('⬅️ Back', 'm:menu')
}

export function settingsText(c: Catalog, prefs: Prefs, defaultCwd: string): string {
  return (
    `⚙️ Settings — defaults for 🆕/⚡ new sessions:\n` +
    `Model: ${modelLabel(c, prefs.defaultModel)} (${prefs.defaultModel})\n` +
    `Effort: ${prefs.defaultEffort ?? 'default (Claude Code decides)'}\n` +
    `Folder: ${defaultCwd}\n\n${modelLines(c)}`
  )
}

export function topicControlsKb(c: Catalog, b: Binding): InlineKeyboard {
  const kb = new InlineKeyboard()
  for (const k of c.enabled) kb.text(`${MODEL_MENU[k].short}${b.model === c.ids[k] ? ' ✓' : ''}`, `m:tm:${k}`)
  kb.row()
  if (supportsEffort(c, b.model)) effortRows(kb, b.effort, 'te')
  kb.text(b.auto ? '⚡ Auto: ON → switch to approvals' : '🔐 Approvals: ON → switch to auto', 'm:ta').row()
  kb.text(feedOn(b) ? '🔎 Activity feed: ON → hide tool calls' : '🔎 Activity feed: OFF → show tool calls', 'm:tf').row()
  kb.text('💾 Close & keep', 'm:tclose').text('🗑 Close & delete', 'm:tdelete').row()
  kb.text('🧹 Close, delete & remove all', 'm:twipe')
  return kb
}

export function topicControlsText(c: Catalog, b: Binding, note?: string): string {
  const effort = supportsEffort(c, b.model) ? ` · 🎚 ${b.effort ?? 'default'}` : ''
  return (
    `⚙️ "${b.title}"\n` +
    `Model: ${modelLabel(c, b.model)} (${b.model})${effort} · ${b.auto ? '⚡ auto (no prompts)' : '🔐 approvals on'} · 🔎 feed ${feedOn(b) ? 'on' : 'off'}\n` +
    `cwd ${b.cwd}\n\n💬 Just type your request below.${note ? `\n${note}` : ''}`
  )
}

export function pageMeta(total: number, page: number): { p: number; pages: number } {
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  return { p: Math.min(Math.max(0, page), pages - 1), pages }
}
export function pageSuffix(total: number, page: number): string {
  const { p, pages } = pageMeta(total, page)
  return pages > 1 ? ` · page ${p + 1}/${pages}` : ''
}

/** Paginated button list: two per row, PAGE_SIZE per page, prev/next only where they lead somewhere. */
export function pagedListKb(
  buttons: { label: string; data: string }[],
  page: number,
  navPrefix: string,
  extra?: (kb: InlineKeyboard) => void,
): InlineKeyboard {
  const { p, pages } = pageMeta(buttons.length, page)
  const slice = buttons.slice(p * PAGE_SIZE, p * PAGE_SIZE + PAGE_SIZE)
  const kb = new InlineKeyboard()
  slice.forEach((b, i) => {
    kb.text(b.label.slice(0, 60), b.data)
    if (i % 2 === 1) kb.row()
  })
  if (slice.length % 2 === 1) kb.row()
  if (pages > 1) {
    if (p > 0) kb.text('◀️ Prev', `m:${navPrefix}:${p - 1}`)
    if (p < pages - 1) kb.text('Next ▶️', `m:${navPrefix}:${p + 1}`)
    kb.row()
  }
  extra?.(kb)
  return kb
}

export function wizardModelKb(c: Catalog): InlineKeyboard {
  const kb = new InlineKeyboard()
  for (const k of c.enabled) kb.text(MODEL_MENU[k].long, `m:nm:${k}`).row()
  return kb.text('⬅️ Back', 'm:new').text('✖️ Cancel', 'm:cancel')
}
export function wizardEffortKb(settingsDefault: Effort | undefined): InlineKeyboard {
  const kb = new InlineKeyboard()
  for (const e of EFFORT_LEVELS) kb.text(EFFORT_MENU[e].long, `m:ne:${e}`).row()
  kb.text(`↺ default${settingsDefault ? ` (settings: ${settingsDefault})` : ' (Claude Code decides)'}`, 'm:ne:auto').row()
  return kb.text('⬅️ Back', 'm:nback').text('✖️ Cancel', 'm:cancel')
}
export function wizardAutoKb(): InlineKeyboard {
  return new InlineKeyboard()
    .text('🔐 Ask me before running tools (recommended)', 'm:na:0').row()
    .text('⚡ Auto-run everything (no prompts)', 'm:na:1').row()
    .text('✖️ Cancel', 'm:cancel')
}

/** Clarifying-question options; `token` is a short id, never the question text. */
export function askKeyboard(token: string, options: { label: string }[], multi: boolean, selected: Set<number>): InlineKeyboard {
  const kb = new InlineKeyboard()
  options.forEach((o, i) => {
    const mark = multi && selected.has(i) ? '✓ ' : ''
    kb.text(`${mark}${o.label}`.slice(0, 60), `qa:${token}:${i}`).row()
  })
  if (multi) kb.text('✅ Done', `qa:${token}:done`)
  return kb
}

export const approveKb = (token: string): InlineKeyboard => new InlineKeyboard().text('✅ Allow', `p:${token}:a`).text('❌ Deny', `p:${token}:d`)

export const controlsKb = (): InlineKeyboard => new InlineKeyboard().text('⚙️ Controls', 'm:ctl')

/** On the live status message: ask the session to finish its step and hand off. */
export const statusLiveKb = (): InlineKeyboard => new InlineKeyboard().text('⏹ Wrap up', 'm:twrap')

/**
 * The wrap-up choices. There is no "drop the queue": messages sent during a turn are
 * already with the session (the CLI folds them into the running or the next turn), so
 * nothing can be taken back; the confirmation says so instead of offering it.
 */
export function wrapConfirmKb(): InlineKeyboard {
  return new InlineKeyboard()
    .text('⏹ Hand off at the next step (recommended)', 'm:tw:now').row()
    .text('⏳ Finish this turn first, then hand off', 'm:tw:turn').row()
    .text('↩️ Cancel', 'm:ctl')
}

export function wrapConfirmText(queued: number): string {
  return (
    `⏹ Wrap up this session?\n\n` +
    `The session finishes the step it is on (or the whole turn), writes a short hand-off (done · open · how to resume) and stops. ` +
    `Nothing is lost: the context stays in the transcript and ▶️ Resume continues from the hand-off.` +
    (queued > 0 ? `\n\nThe ${queued === 1 ? 'message' : `${queued} messages`} you sent during this turn ${queued === 1 ? 'is' : 'are'} already with the session; the hand-off will cover ${queued === 1 ? 'it' : 'them'}.` : '')
  )
}

/** Under a hand-off: send its Resume paragraph as the next message. */
export const resumeKb = (): InlineKeyboard => new InlineKeyboard().text('▶️ Resume from hand-off', 'm:tres')

/** Test helpers: what a keyboard would send back, and what it shows. */
export function callbackData(kb: InlineKeyboard): string[] {
  return kb.inline_keyboard.flat().flatMap(b => ('callback_data' in b && typeof b.callback_data === 'string' ? [b.callback_data] : []))
}
export function labels(kb: InlineKeyboard): string[] {
  return kb.inline_keyboard.flat().map(b => b.text)
}
