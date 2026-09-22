/**
 * The Telegram side: grammy handlers and the delivery of everything the user reads.
 * Decisions live in the modules this file calls (commands, wizard, keyboards,
 * interpret via TopicManager); this file is the plumbing between them and the
 * Telegram API, plus the permission prompts a session blocks on.
 */
import { Bot, InlineKeyboard, InputFile, type Context } from 'grammy'
import type { CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk'
import { basename } from 'path'
import type { Config } from './config'
import { parseTyped } from './commands'
import { FeedBatcher, describeTask } from './feed'
import { deleteTranscript, isImage, listRepoFolders, type Files } from './files'
import type { Event } from './interpret'
import type { Logger, Metrics } from './log'
import { htmlEsc, htmlToPlain, renderWithDeadline, chunkHtml, chunkPlain } from './markdown'
import { isEnabledModelKey, modelLabel, parseEffort, supportsEffort, MODEL_MENU, type Effort } from './models'
import { listSessions } from './session'
import { feedOn, type Binding, type Store } from './state'
import type { SessionExtras, TopicManager } from './topics'
import {
  approveKb,
  askKeyboard,
  backKb,
  controlsKb,
  mainMenuKb,
  openLinkKb,
  pagedListKb,
  pageSuffix,
  settingsKb,
  settingsText,
  topicControlsKb,
  topicControlsText,
  wizardAutoKb,
  wizardEffortKb,
  wizardModelKb,
} from './ui/keyboards'
import { startWizard, wizardStep, type WizardState } from './ui/wizard'

import { AUTO_ALLOW, preToolUseHookOutput } from './gate'
export { AUTO_ALLOW }

export type BotDeps = {
  cfg: Config
  store: Store
  files: Files
  log: Logger
  metrics: Metrics
  /** Text for the 📊 Status screen; built by the daemon, which owns uptime and versions. */
  statusText: () => string
}

type Pending = { resolve: (r: PermissionResult) => void; topicId: string; messageId?: number }
type AskBtn = { multi: boolean; selected: Set<number>; options: { label: string; description?: string }[]; messageId: number; resolve: (v: string | string[]) => void }
const FREE_TEXT = Symbol('free-text')

export class TelegramBot {
  readonly bot: Bot
  private topics!: TopicManager
  private readonly pending = new Map<string, Pending>()
  private readonly askBtns = new Map<string, AskBtn>()
  private readonly askFreeText = new Map<string, (t: string) => void>()
  private readonly wizard = new Map<string, WizardState>()
  private defaultFolderChoices: string[] = []
  private tokenSeed = 0
  /** Set for the duration of a button tap so menu screens repaint the tapped message in place. */
  private menuCtx: Context | undefined
  readonly feed: FeedBatcher

  constructor(private readonly d: BotDeps) {
    this.bot = new Bot(d.cfg.telegramToken)
    this.feed = new FeedBatcher((topicId, text) => void this.send(topicId, text))
    this.wire()
  }

  attachTopics(topics: TopicManager): void {
    this.topics = topics
  }

  // ── delivery ─────────────────────────────────────────────────────────────

  /** Claude's markdown → Telegram HTML, chunked; plain-text fallback so nothing is dropped. */
  async say(topicId: string | undefined, text: string): Promise<void> {
    const opts = topicId ? { message_thread_id: Number(topicId) } : {}
    const html = await renderWithDeadline(text, 1500)
    if (html === undefined) this.d.metrics.inc('render_degraded')
    // Rendered output is split HTML-aware; the unformatted fallback is split as plain
    // text, because the HTML splitter would read its angle brackets as tags.
    for (const part of html !== undefined ? chunkHtml(html, 3500) : chunkPlain(text, 3500)) {
      if (html) {
        try {
          await this.bot.api.sendMessage(this.d.cfg.forumChatId, part, { ...opts, parse_mode: 'HTML' })
          this.d.metrics.inc('text_sent')
          this.d.log.debug('out.sent', { topic: topicId, bytes: part.length, mode: 'html' })
          continue
        } catch (e) {
          this.d.metrics.inc('html_rejected')
          this.d.log.warn('out.html_rejected', { topic: topicId, error: e })
        }
      }
      const plain = html ? htmlToPlain(part) : part
      try {
        await this.bot.api.sendMessage(this.d.cfg.forumChatId, plain, opts)
        this.d.metrics.inc('text_sent')
        this.d.log.debug('out.sent', { topic: topicId, bytes: plain.length, mode: 'plain' })
      } catch (e) {
        this.d.metrics.inc('send_failed')
        this.d.log.error('out.send_failed', { topic: topicId, error: e })
      }
    }
  }

  /** Plain send (menus, notices, feed). */
  async send(topicId: string | undefined, text: string, kb?: InlineKeyboard): Promise<void> {
    const opts: Record<string, unknown> = topicId ? { message_thread_id: Number(topicId) } : {}
    if (kb) opts.reply_markup = kb
    try {
      await this.bot.api.sendMessage(this.d.cfg.forumChatId, text, opts)
    } catch (e) {
      this.d.metrics.inc('send_failed')
      this.d.log.error('out.send_failed', { topic: topicId, error: e })
    }
  }

  /** Repaint the tapped menu message in place when possible, else send fresh. */
  private async paint(topicId: string | undefined, text: string, kb?: InlineKeyboard): Promise<void> {
    if (this.menuCtx?.callbackQuery?.message) {
      try {
        await this.menuCtx.editMessageText(text, { reply_markup: kb })
        return
      } catch {}
    }
    await this.send(topicId, text, kb)
  }

  private async typing(topicId: string): Promise<void> {
    await this.bot.api.sendChatAction(this.d.cfg.forumChatId, 'typing', { message_thread_id: Number(topicId) }).catch(() => {})
  }

  // ── events from sessions ─────────────────────────────────────────────────

  async onEvent(topicId: string, ev: Event): Promise<void> {
    const b = this.d.store.registry[topicId]
    switch (ev.kind) {
      case 'say':
        await this.say(topicId, ev.text)
        return
      case 'feed':
        this.d.metrics.inc('feed_lines', ev.lines.length)
        this.feed.add(topicId, ev.lines)
        return
      case 'sessionId': {
        const cwd = b?.cwd ?? this.d.cfg.defaultCwd
        await this.say(topicId, `🆔 Session id: ${ev.id}\nResume on laptop:\ncd ${cwd} && claude --resume ${ev.id}`)
        return
      }
      case 'turnEnd':
        this.feed.fire(topicId)
        await this.flushOutbox(topicId)
        return
      case 'turnError': {
        this.feed.fire(topicId)
        await this.flushOutbox(topicId)
        if (ev.afterRateLimit) return // the friendlier rate-limit notice was already shown
        const detail = ev.errors.length ? `\n${ev.errors.map(e => e.slice(0, 300)).join('\n')}` : ''
        await this.send(topicId, `⚠️ turn ended: ${ev.subtype}.${detail}\nTap ⚙️ to switch model or adjust this session.`, controlsKb())
        return
      }
      case 'task': {
        const line = describeTask(ev.status, ev.description, ev.background)
        if (ev.status === 'started') {
          if (b && feedOn(b)) this.feed.add(topicId, [line])
        } else {
          // A settled background task is always surfaced: the SDK re-invokes the model with
          // the result, but if that continuation is rate-limited the user would never hear.
          await this.say(topicId, line)
        }
        return
      }
      case 'denied':
        await this.send(topicId, `🚫 ${ev.tool} was denied: ${ev.message}`)
        return
      case 'assistantError':
        this.d.metrics.inc('assistant_errors')
        await this.send(topicId, `⚠️ model error: ${ev.error}. Tap ⚙️ to switch model or adjust this session.`, controlsKb())
        return
      case 'state':
        if (ev.state === 'running') await this.typing(topicId)
        return
      default:
        return
    }
  }

  /**
   * What every session needs from the bot: the permission gate in two halves. The
   * PreToolUse hook forces a prompt for every non-read-only tool (settings allow rules
   * would otherwise approve it before any callback runs), and canUseTool is that prompt:
   * Allow/Deny buttons, question options, plan approval, or auto mode.
   * The outbox contract is NOT a SessionStart hook: measured against SDK 0.3.278, an
   * SDK-registered SessionStart callback never ran, so the contract is prepended to the
   * topic's first prompt instead (TopicManager.sendToTopic).
   */
  extras(topicId: string): SessionExtras {
    return {
      canUseTool: this.makeCanUseTool(topicId),
      hooks: {
        PreToolUse: [{ hooks: [async (input: any) => preToolUseHookOutput(String(input?.tool_name ?? '')) as any] }],
      },
    }
  }

  // ── permissions & questions ─────────────────────────────────────────────

  private token(): string {
    this.tokenSeed = (this.tokenSeed + 1) % 100000
    return this.tokenSeed.toString(36)
  }

  private makeCanUseTool(topicId: string): CanUseTool {
    return async (toolName, input, opts) => {
      // Clarifying questions always render real options, even in auto mode: a question
      // needs an answer, and auto-allowing it would return none.
      if (toolName === 'AskUserQuestion') return this.askQuestions(topicId, input)
      if (AUTO_ALLOW.includes(toolName)) return { behavior: 'allow', updatedInput: input }
      if (this.d.store.registry[topicId]?.auto) {
        this.d.metrics.inc('auto_allowed')
        return { behavior: 'allow', updatedInput: input }
      }
      if (toolName === 'ExitPlanMode') {
        const plan = typeof input.plan === 'string' ? input.plan : JSON.stringify(input.plan ?? input)
        await this.say(topicId, `📋 Proposed plan:\n\n${plan}`)
        return this.askApprove(topicId, '🔐 Approve this plan and proceed?')
      }
      const label = htmlEsc(opts.displayName || toolName)
      const desc = opts.description
      const detail = desc ? `\n${htmlEsc(desc.length > 800 ? desc.slice(0, 800) + '…' : desc)}` : summarizeInput(toolName, input)
      return this.askApprove(topicId, `🔐 ${label}${detail}`)
    }
  }

  /** HTML first; plain retry if Telegram's parser rejects it. An approval prompt is never dropped. */
  private async askApprove(topicId: string, promptText: string): Promise<PermissionResult> {
    const token = this.token()
    const base = { message_thread_id: Number(topicId), reply_markup: approveKb(token) }
    let messageId: number | undefined
    try {
      messageId = (await this.bot.api.sendMessage(this.d.cfg.forumChatId, promptText, { ...base, parse_mode: 'HTML' })).message_id
    } catch {
      try {
        messageId = (await this.bot.api.sendMessage(this.d.cfg.forumChatId, htmlToPlain(promptText), base)).message_id
      } catch (e) {
        this.d.log.error('approval.send_failed', { topic: topicId, error: e })
        return { behavior: 'deny', message: 'could not deliver approval prompt' }
      }
    }
    this.d.metrics.inc('approvals_asked')
    return new Promise<PermissionResult>(resolve => this.pending.set(token, { resolve, topicId, messageId }))
  }

  private askSingle(topicId: string, q: any): Promise<string | string[]> {
    const token = this.token()
    const multi = !!q.multiSelect
    const selected = new Set<number>()
    const options = (q.options || []) as { label: string; description?: string }[]
    const body =
      `❓ ${q.header ? q.header + ': ' : ''}${q.question}\n\n` +
      options.map((o, i) => `${i + 1}. ${o.label}${o.description ? ' — ' + o.description : ''}`).join('\n') +
      `\n\n(tap a choice${multi ? '; ✅ Done when finished' : ''}, or just type your own reply)`
    return this.bot.api
      .sendMessage(this.d.cfg.forumChatId, body, { message_thread_id: Number(topicId), reply_markup: askKeyboard(token, options, multi, selected) })
      .then(sent => new Promise<string | string[]>(resolve => this.askBtns.set(token, { multi, selected, options, messageId: sent.message_id, resolve })))
  }

  private async askQuestions(topicId: string, input: Record<string, unknown>): Promise<PermissionResult> {
    const questions = (input.questions as any[]) || []
    const answers: Record<string, string | string[]> = {}
    let freeText: string | undefined
    const ft = new Promise<never>((_, reject) => {
      this.askFreeText.set(topicId, t => {
        freeText = t
        reject(FREE_TEXT)
      })
    })
    try {
      for (const q of questions) answers[q.question] = (await Promise.race([this.askSingle(topicId, q), ft])) as string | string[]
    } catch (e) {
      if (e !== FREE_TEXT) throw e
    } finally {
      this.askFreeText.delete(topicId)
    }
    this.d.metrics.inc('questions_answered')
    if (freeText !== undefined) return { behavior: 'allow', updatedInput: { questions, answers: {}, response: freeText } }
    return { behavior: 'allow', updatedInput: { questions, answers } }
  }

  // ── files ────────────────────────────────────────────────────────────────

  private async sendFile(topicId: string, path: string): Promise<boolean> {
    const opts = { message_thread_id: Number(topicId), caption: basename(path) }
    try {
      if (isImage(path)) await this.bot.api.sendPhoto(this.d.cfg.forumChatId, new InputFile(path), opts)
      else await this.bot.api.sendDocument(this.d.cfg.forumChatId, new InputFile(path), opts)
      this.d.metrics.inc('files_sent')
      return true
    } catch (e) {
      this.d.metrics.inc('files_failed')
      this.d.log.warn('media.send_failed', { topic: topicId, path, error: e })
      return false
    }
  }

  async flushOutbox(topicId: string): Promise<void> {
    for (const p of this.d.files.pendingOutbox(topicId)) if (await this.sendFile(topicId, p)) this.d.files.afterSent(p)
  }

  private async download(fileId: string): Promise<Uint8Array> {
    const file = await this.bot.api.getFile(fileId)
    const url = `https://api.telegram.org/file/bot${this.d.cfg.telegramToken}/${file.file_path}`
    return new Uint8Array(await (await fetch(url)).arrayBuffer())
  }

  // ── topics: create / bind / controls ─────────────────────────────────────

  private topicIdOf(ctx: Context): string | undefined {
    const id = ctx.message?.message_thread_id ?? ctx.callbackQuery?.message?.message_thread_id
    return id ? String(id) : undefined
  }

  private async createTopic(name: string): Promise<string> {
    const topic = await this.bot.api.createForumTopic(this.d.cfg.forumChatId, name.slice(0, 120) || 'session')
    return String(topic.message_thread_id)
  }

  private bind(topicId: string, b: Omit<Binding, 'lastActive'>): void {
    this.d.store.registry[topicId] = { ...b, lastActive: Date.now() }
    this.d.store.saveRegistry()
  }

  async postPinnedControls(topicId: string): Promise<void> {
    const b = this.d.store.registry[topicId]
    if (!b) return
    if (b.controlMsgId) {
      await this.bot.api.unpinChatMessage(this.d.cfg.forumChatId, b.controlMsgId).catch(() => {})
      await this.bot.api.deleteMessage(this.d.cfg.forumChatId, b.controlMsgId).catch(() => {})
    }
    try {
      const sent = await this.bot.api.sendMessage(this.d.cfg.forumChatId, topicControlsText(this.d.cfg.catalog, b), {
        message_thread_id: Number(topicId),
        reply_markup: topicControlsKb(this.d.cfg.catalog, b),
      })
      b.controlMsgId = sent.message_id
      this.d.store.saveRegistry()
      // Pin non-silently: the event is what makes mobile Telegram show the per-topic pin bar.
      await this.bot.api.pinChatMessage(this.d.cfg.forumChatId, sent.message_id).catch(e => this.d.log.warn('pin.failed', { topic: topicId, error: e }))
    } catch (e) {
      this.d.log.error('controls.post_failed', { topic: topicId, error: e })
    }
  }

  private async repaintControls(topicId: string, b: Binding, note?: string): Promise<void> {
    await this.paint(topicId, topicControlsText(this.d.cfg.catalog, b, note), topicControlsKb(this.d.cfg.catalog, b))
  }

  private async newSession(name: string, cwd: string, model: string, effort: Effort | undefined, auto: boolean, intoTopic?: string): Promise<string | undefined> {
    let topicId: string
    try {
      topicId = await this.createTopic(name)
    } catch (e) {
      await this.paint(intoTopic, `Couldn't create topic (is the bot admin with Manage Topics?): ${e}`, backKb())
      return undefined
    }
    this.bind(topicId, { cwd, model, effort, title: name, auto })
    this.d.metrics.inc('topics_created')
    this.topics.ensureLive(topicId)
    await this.postPinnedControls(topicId)
    return topicId
  }

  private async attach(shortId: string, name: string | undefined, fromTopic: string | undefined): Promise<string | undefined> {
    let matches
    try {
      matches = (await listSessions()).filter(s => s.sessionId.startsWith(shortId))
    } catch (e) {
      await this.say(fromTopic, `listSessions failed: ${e}`)
      return
    }
    if (matches.length === 0) {
      await this.say(fromTopic, `No session starting with \`${shortId}\`.`)
      return
    }
    if (matches.length > 1) {
      // A prefix that fits several sessions must not bind the first one it happens to
      // meet: that would open (and expose) the wrong transcript. Ask for more characters.
      const list = matches.slice(0, 6).map(s => `• ${s.sessionId.slice(0, 12)}… ${(s.summary || s.firstPrompt || '').replace(/\s+/g, ' ').slice(0, 40)}`).join('\n')
      await this.say(fromTopic, `\`${shortId}\` matches ${matches.length} sessions — use more characters:\n${list}`)
      return
    }
    const match = matches[0]
    const title = name || (match.summary || shortId).slice(0, 40)
    let topicId: string
    try {
      topicId = await this.createTopic(title)
    } catch (e) {
      await this.say(fromTopic, `Couldn't create topic: ${e}`)
      return
    }
    this.bind(topicId, { sessionId: match.sessionId, cwd: match.cwd || this.d.cfg.defaultCwd, model: this.d.store.prefs.defaultModel, effort: this.d.store.prefs.defaultEffort, title })
    await this.postPinnedControls(topicId)
    return topicId
  }

  // ── screens ──────────────────────────────────────────────────────────────

  private async showMainMenu(topicId: string | undefined): Promise<void> {
    await this.paint(topicId, '👋 What would you like to do?', mainMenuKb())
  }

  private async showSettings(topicId: string | undefined): Promise<void> {
    await this.paint(topicId, settingsText(this.d.cfg.catalog, this.d.store.prefs, this.d.store.defaultCwd()), settingsKb(this.d.cfg.catalog, this.d.store.prefs))
  }

  private async showSessions(topicId: string | undefined, page: number): Promise<void> {
    let sessions
    try {
      sessions = (await listSessions()).sort((a, b) => b.lastModified - a.lastModified)
    } catch (e) {
      return void this.paint(topicId, `Couldn't load sessions: ${e}`, backKb())
    }
    if (!sessions.length) return void this.paint(topicId, 'No sessions yet.', new InlineKeyboard().text('🆕 New session', 'm:new').row().text('⬅️ Back', 'm:menu'))
    const bound = new Map(Object.values(this.d.store.registry).filter(b => b.sessionId).map(b => [b.sessionId as string, b]))
    const buttons = sessions.map(s => {
      const b = bound.get(s.sessionId)
      const mark = b ? (this.topics.isLive(Object.keys(this.d.store.registry).find(k => this.d.store.registry[k] === b) ?? '') ? '🟢' : '📌') : ''
      const title = (s.customTitle || s.summary || s.firstPrompt || 'untitled').replace(/\s+/g, ' ').slice(0, 26)
      return { label: `${mark}${title}`.slice(0, 30), data: `m:sess:${s.sessionId.slice(0, 8)}` }
    })
    const kb = pagedListKb(buttons, page, 'spage', k => k.text('🆕 New', 'm:new').text('⬅️ Back', 'm:menu'))
    await this.paint(topicId, `📋 Your sessions (${sessions.length})${pageSuffix(buttons.length, page)} — tap one to open:`, kb)
  }

  private async showDefaultFolderPicker(topicId: string | undefined, page: number): Promise<void> {
    this.defaultFolderChoices = listRepoFolders(this.d.cfg.reposDir, this.d.store.defaultCwd())
    const buttons = this.defaultFolderChoices.map((f, i) => ({ label: '📁 ' + basename(f), data: `m:sdfi:${i}` }))
    await this.paint(topicId, `📁 Pick the default folder for new sessions:${pageSuffix(buttons.length, page)}`, pagedListKb(buttons, page, 'sdfp', k => k.text('⬅️ Back', 'm:settings')))
  }

  private async renderWizard(uid: string, topicId: string | undefined, page = 0): Promise<void> {
    const w = this.wizard.get(uid)
    if (!w) return void this.paint(topicId, 'Expired — tap 🆕 again.', mainMenuKb())
    switch (w.step) {
      case 'folder': {
        const buttons = w.folders.map((f, i) => ({ label: '📁 ' + basename(f), data: `m:nf:${i}` }))
        const kb = pagedListKb(buttons, page, 'fpage', k => k.text('⬅️ Back', 'm:menu').text('✖️ Cancel', 'm:cancel'))
        return void this.paint(topicId, `📁 Step 1/4 — pick a folder (from ${this.d.cfg.reposDir}):${pageSuffix(buttons.length, page)}`, kb)
      }
      case 'model':
        return void this.paint(topicId, `🤖 Step 2/4 — pick a model:\n${modelLinesText(this.d.cfg)}`, wizardModelKb(this.d.cfg.catalog))
      case 'effort':
        return void this.paint(topicId, '🎚 Step 3/4 — how hard should it think?', wizardEffortKb(this.d.store.prefs.defaultEffort))
      case 'auto':
        return void this.paint(topicId, '🔐 Step 4/4 — how should tools run?', wizardAutoKb())
    }
  }

  private async finishWizard(uid: string, done: { cwd: string; model: string; effort: Effort | undefined; auto: boolean; bindTopic: string | undefined }): Promise<void> {
    this.wizard.delete(uid)
    const name = basename(done.cwd)
    const effort = done.effort ?? this.d.store.prefs.defaultEffort
    let topicId = done.bindTopic
    if (!topicId) {
      try {
        topicId = await this.createTopic(name)
      } catch (e) {
        await this.send(undefined, `Couldn't create topic (is the bot admin with Manage Topics?): ${e}`)
        return
      }
    }
    this.bind(topicId, { cwd: done.cwd, model: done.model, effort, title: name, auto: done.auto })
    this.d.metrics.inc('topics_created')
    this.topics.ensureLive(topicId)
    if (done.bindTopic) {
      const wizMsg = this.menuCtx?.callbackQuery?.message?.message_id
      if (wizMsg) await this.bot.api.deleteMessage(this.d.cfg.forumChatId, wizMsg).catch(() => {})
    } else {
      await this.paint(undefined, `✅ Created "${name}".`, openLinkKb(this.d.cfg.forumChatId, topicId))
    }
    await this.postPinnedControls(topicId)
  }

  // ── menu taps ────────────────────────────────────────────────────────────

  private async handleMenu(ctx: Context, data: string): Promise<void> {
    const uid = String(ctx.from?.id)
    const topicId = this.topicIdOf(ctx)
    const ack = (t?: string) => ctx.answerCallbackQuery(t ? { text: t } : undefined).catch(() => {})
    const { catalog } = this.d.cfg
    const store = this.d.store

    if (data === 'm:menu') return void (await ack(), this.showMainMenu(topicId))
    if (data === 'm:noop') return void ack()
    if (data === 'm:new' || data === 'm:newhere') {
      await ack()
      this.wizard.set(uid, startWizard(listRepoFolders(this.d.cfg.reposDir, store.defaultCwd()), data === 'm:newhere' ? topicId : undefined))
      return this.renderWizard(uid, topicId)
    }
    if (data === 'm:quick') {
      await ack('Creating…')
      const cwd = store.defaultCwd()
      const tid = await this.newSession(basename(cwd), cwd, store.prefs.defaultModel, store.prefs.defaultEffort, false, topicId)
      if (tid) await this.paint(topicId, `✅ Created "${basename(cwd)}".`, openLinkKb(this.d.cfg.forumChatId, tid))
      return
    }
    if (data === 'm:list') return void (await ack(), this.showSessions(topicId, 0))
    if (data === 'm:resume') {
      await ack('Resuming…')
      let sessions
      try {
        sessions = (await listSessions()).sort((a, b) => b.lastModified - a.lastModified)
      } catch (e) {
        return void this.paint(topicId, `Couldn't load sessions: ${e}`, backKb())
      }
      if (!sessions.length) return void this.paint(topicId, 'No sessions yet.', backKb())
      const last = sessions[0]
      const already = Object.values(store.registry).find(b => b.sessionId === last.sessionId)
      if (already) return void this.paint(topicId, `📌 Most recent "${already.title}" is already open.`, backKb())
      await this.paint(topicId, '📎 Opening the most recent session…', backKb())
      const tid = await this.attach(last.sessionId.slice(0, 8), undefined, topicId)
      return void this.paint(topicId, tid ? `✅ Opened "${last.summary || last.sessionId.slice(0, 8)}".` : '⚠️ Could not open that session.', tid ? openLinkKb(this.d.cfg.forumChatId, tid) : backKb())
    }
    if (data === 'm:settings') return void (await ack(), this.showSettings(topicId))
    if (data === 'm:status') return void (await ack(), this.paint(topicId, this.d.statusText(), backKb()))
    if (data === 'm:help') return void (await ack(), this.send(topicId, help(this.d.cfg.reposDir), backKb()))
    if (data === 'm:cancel') {
      this.wizard.delete(uid)
      await ack('Cancelled')
      return this.showMainMenu(topicId)
    }
    if (data === 'm:ctl') return void (await ack(), topicId && store.registry[topicId] ? this.postPinnedControls(topicId) : this.showMainMenu(topicId))

    // Settings
    const sdm = /^m:sdm:(\w+)$/.exec(data)
    if (sdm && isEnabledModelKey(catalog, sdm[1])) {
      store.prefs.defaultModel = catalog.ids[sdm[1]]
      store.savePrefs()
      await ack(`Default: ${sdm[1]}`)
      return this.showSettings(topicId)
    }
    const sde = /^m:sde:(\w+)$/.exec(data)
    if (sde && (sde[1] === 'auto' || parseEffort(sde[1]))) {
      store.prefs.defaultEffort = parseEffort(sde[1])
      store.savePrefs()
      await ack(`Default effort: ${store.prefs.defaultEffort ?? 'default'}`)
      return this.showSettings(topicId)
    }
    if (data === 'm:sdf') return void (await ack(), this.showDefaultFolderPicker(topicId, 0))
    const sdfp = /^m:sdfp:(\d+)$/.exec(data)
    if (sdfp) return void (await ack(), this.showDefaultFolderPicker(topicId, Number(sdfp[1])))
    const sdfi = /^m:sdfi:(\d+)$/.exec(data)
    if (sdfi) {
      const f = this.defaultFolderChoices[Number(sdfi[1])]
      if (f) {
        store.prefs.defaultCwd = f
        store.savePrefs()
      }
      await ack(f ? basename(f) : 'expired')
      return this.showSettings(topicId)
    }

    // Pagination
    const sp = /^m:spage:(\d+)$/.exec(data)
    if (sp) return void (await ack(), this.showSessions(topicId, Number(sp[1])))
    const fp = /^m:fpage:(\d+)$/.exec(data)
    if (fp) return void (await ack(), this.renderWizard(uid, topicId, Number(fp[1])))

    // Open a session from the list
    const sess = /^m:sess:([0-9a-f]+)$/.exec(data)
    if (sess) {
      await ack('Opening…')
      const already = Object.values(store.registry).find(b => b.sessionId?.startsWith(sess[1]))
      if (already) return void this.paint(topicId, `📌 "${already.title}" is already open.`, backKb())
      await this.paint(topicId, '📎 Opening session…', backKb())
      const tid = await this.attach(sess[1], undefined, topicId)
      return void this.paint(topicId, tid ? '✅ Session opened.' : '⚠️ Could not open that session.', tid ? openLinkKb(this.d.cfg.forumChatId, tid) : backKb())
    }

    // Wizard
    const w = this.wizard.get(uid)
    const wizardAction = (() => {
      const nf = /^m:nf:(\d+)$/.exec(data)
      if (nf) return { type: 'pickFolder' as const, index: Number(nf[1]) }
      const nm = /^m:nm:(\w+)$/.exec(data)
      if (nm) return { type: 'pickModel' as const, key: nm[1] }
      const ne = /^m:ne:(\w+)$/.exec(data)
      if (ne) return { type: 'pickEffort' as const, effort: (ne[1] === 'auto' ? 'default' : ne[1]) as Effort | 'default' }
      if (data === 'm:nback') return { type: 'back' as const }
      const na = /^m:na:(0|1)$/.exec(data)
      if (na) return { type: 'pickAuto' as const, auto: na[1] === '1' }
      return undefined
    })()
    if (wizardAction) {
      if (!w) return void ack('Expired — tap 🆕 again')
      const r = wizardStep(w, wizardAction, catalog)
      if (r.refused) return void ack(r.refused)
      this.wizard.set(uid, r.state)
      if (r.done) {
        await ack(r.done.auto ? '⚡ Auto' : '🔐 Approvals')
        return this.finishWizard(uid, r.done)
      }
      await ack(wizardAction.type === 'pickModel' && r.state.model ? modelLabel(catalog, r.state.model) : wizardAction.type === 'pickEffort' ? `🎚 ${r.state.effort ?? 'default'}` : undefined)
      return this.renderWizard(uid, topicId)
    }

    // Topic controls
    if (!topicId) return void ack()
    const b = store.registry[topicId]
    const tm = /^m:tm:(\w+)$/.exec(data)
    if (tm && isEnabledModelKey(catalog, tm[1])) {
      if (!b) return void ack('No session here')
      b.model = catalog.ids[tm[1]]
      store.saveRegistry()
      this.topics.closeLive(topicId, 'model switch')
      await ack(`Model: ${tm[1]}`)
      return this.repaintControls(topicId, b, '(applies on next message)')
    }
    const te = /^m:te:(\w+)$/.exec(data)
    if (te && (te[1] === 'auto' || parseEffort(te[1]))) {
      if (!b) return void ack('No session here')
      b.effort = parseEffort(te[1])
      store.saveRegistry()
      this.topics.closeLive(topicId, 'effort switch')
      await ack(`Effort: ${b.effort ?? 'default'}`)
      return this.repaintControls(topicId, b, '(applies on next message)')
    }
    if (data === 'm:tf') {
      if (!b) return void ack('No session here')
      b.feed = !feedOn(b)
      store.saveRegistry()
      await ack(b.feed ? '🔎 Feed ON' : '🔎 Feed OFF')
      return this.repaintControls(topicId, b)
    }
    if (data === 'm:ta') {
      if (!b) return void ack('No session here')
      b.auto = !b.auto
      store.saveRegistry()
      await ack(b.auto ? '⚡ Auto ON' : '🔐 Approvals ON')
      return this.repaintControls(topicId, b)
    }
    if (data === 'm:tclose') {
      this.topics.userTookOver(topicId)
      this.topics.closeLive(topicId, 'closed & kept by user')
      this.feed.drop(topicId)
      if (b?.controlMsgId) await this.bot.api.unpinChatMessage(this.d.cfg.forumChatId, b.controlMsgId).catch(() => {})
      await ack('💾 Closed')
      await this.paint(topicId, '💾 Session closed and saved — your context is kept. Reopen to resume.', new InlineKeyboard().text('♻️ Reopen & resume', 'm:treopen'))
      await this.bot.api.closeForumTopic(this.d.cfg.forumChatId, Number(topicId)).catch(e => this.d.log.warn('topic.close_failed', { topic: topicId, error: e }))
      return
    }
    if (data === 'm:treopen') {
      await this.bot.api.reopenForumTopic(this.d.cfg.forumChatId, Number(topicId)).catch(e => this.d.log.warn('topic.reopen_failed', { topic: topicId, error: e }))
      if (!b) return void this.paint(topicId, 'That session no longer exists.', backKb())
      this.topics.ensureLive(topicId)
      await ack('♻️ Reopened')
      await this.repaintControls(topicId, b)
      if (b.controlMsgId) await this.bot.api.pinChatMessage(this.d.cfg.forumChatId, b.controlMsgId).catch(() => {})
      return
    }
    if (data === 'm:tdelete') {
      await ack()
      return this.paint(
        topicId,
        '🗑 Delete this topic and forget its session here?\nThe transcript stays on disk and can be reopened later from 📋 My sessions or /attach. To remove everything, use 🧹 instead.',
        new InlineKeyboard().text('🗑 Yes, delete', 'm:tdelyes').text('↩️ Cancel', 'm:ctl'),
      )
    }
    if (data === 'm:tdelyes') {
      this.removeTopic(topicId, false)
      await ack('🗑 Deleted')
      await this.bot.api.deleteForumTopic(this.d.cfg.forumChatId, Number(topicId)).catch(e => this.d.log.warn('topic.delete_failed', { topic: topicId, error: e }))
      return
    }
    if (data === 'm:twipe') {
      await ack()
      return this.paint(
        topicId,
        '🧹 Remove EVERYTHING for this topic — the session, its transcript (no longer resumable), delivered files, and the topic itself?\nThis cannot be undone.',
        new InlineKeyboard().text('🧹 Yes, wipe it all', 'm:twipeyes').text('↩️ Cancel', 'm:ctl'),
      )
    }
    if (data === 'm:twipeyes') {
      this.removeTopic(topicId, true)
      await ack('🧹 Wiped')
      await this.bot.api.deleteForumTopic(this.d.cfg.forumChatId, Number(topicId)).catch(e => this.d.log.warn('topic.wipe_failed', { topic: topicId, error: e }))
      return
    }
    await ack()
  }

  private removeTopic(topicId: string, wipe: boolean): void {
    const sid = this.d.store.registry[topicId]?.sessionId
    this.topics.userTookOver(topicId)
    this.topics.closeLive(topicId, wipe ? 'wiped by user' : 'deleted by user')
    this.topics.forget(topicId)
    this.feed.drop(topicId)
    delete this.d.store.registry[topicId]
    this.d.store.saveRegistry()
    this.d.metrics.inc(wipe ? 'topics_wiped' : 'topics_deleted')
    if (wipe) {
      this.d.files.removeOutbox(topicId)
      if (sid) for (const f of deleteTranscript(sid)) this.d.log.info('wipe.transcript_removed', { topic: topicId, file: f })
    }
  }

  // ── typed text ───────────────────────────────────────────────────────────

  private async handleText(ctx: Context, raw: string): Promise<void> {
    const topicId = this.topicIdOf(ctx)
    const typed = parseTyped(raw, this.d.cfg.catalog)
    this.d.log.debug('in.text', { topic: topicId ?? 'general', kind: typed.kind, len: raw.length })

    if (typed.kind === 'slash') {
      switch (typed.cmd) {
        case 'new': {
          const { name, cwd, auto, notes } = parseNew(typed.args, this.d.store.defaultCwd())
          for (const n of notes) await this.say(topicId, n)
          await this.newSession(name, cwd, this.d.store.prefs.defaultModel, this.d.store.prefs.defaultEffort, auto, topicId)
          return
        }
        case 'list':
          return this.showSessions(topicId, 0)
        case 'attach': {
          const [shortId, ...rest] = typed.args.trim().split(/\s+/)
          if (!shortId) return void this.say(topicId, 'Usage: /attach <short-id> [topic name]')
          await this.attach(shortId, rest.join(' ') || undefined, topicId)
          return
        }
        case 'auto': {
          if (!topicId) return void this.say(undefined, '/auto must be used inside a session topic.')
          const b = this.d.store.registry[topicId]
          if (!b) return void this.say(topicId, 'No session bound to this topic yet — send a message first, or /new.')
          const arg = typed.args.trim().toLowerCase()
          b.auto = arg === 'on' ? true : arg === 'off' ? false : !b.auto
          this.d.store.saveRegistry()
          return void this.say(topicId, b.auto ? '⚡ Auto mode ON — tools run without asking (questions still prompt). /auto off to disable.' : '🔐 Auto mode OFF — risky tools (Bash/Write/Edit/Web) will ask for Allow/Deny.')
        }
        case 'status':
          return void this.send(topicId, this.d.statusText())
        case 'menu':
          return topicId && this.d.store.registry[topicId] ? this.postPinnedControls(topicId) : this.showMainMenu(topicId)
        case 'help':
          return void this.say(topicId, help(this.d.cfg.reposDir))
        default:
          return this.showMainMenu(topicId)
      }
    }

    if (!topicId) return this.showMainMenu(undefined) // plain text in General → the menu

    // A pending clarifying question takes any typed reply as its free-text answer.
    const ft = this.askFreeText.get(topicId)
    if (ft) return void ft(raw)

    const b = this.d.store.registry[topicId]
    if (typed.kind === 'use' || typed.kind === 'effort' || typed.kind === 'feed') {
      if (!b) return void this.say(topicId, 'No session bound here.')
      if (typed.kind === 'use') {
        const label = MODEL_MENU[typed.model].short
        if (!isEnabledModelKey(this.d.cfg.catalog, typed.model)) {
          return void this.say(topicId, `${label} is not enabled on this install (ENABLED_MODELS=${this.d.cfg.catalog.enabled.join(',')}).`)
        }
        b.model = this.d.cfg.catalog.ids[typed.model]
        if (typed.effort) b.effort = typed.effort
        this.d.store.saveRegistry()
        this.topics.closeLive(topicId, 'model switch')
        const eff = supportsEffort(this.d.cfg.catalog, b.model) && b.effort ? ` · effort ${b.effort}` : ''
        return void this.say(topicId, `Model set to ${b.model}${eff}. (applies on next message)`)
      }
      if (typed.kind === 'effort') {
        if (!supportsEffort(this.d.cfg.catalog, b.model)) return void this.say(topicId, `${modelLabel(this.d.cfg.catalog, b.model)} has no effort levels — switch model first.`)
        b.effort = typed.effort
        this.d.store.saveRegistry()
        this.topics.closeLive(topicId, 'effort switch')
        return void this.say(topicId, `Effort set to ${typed.effort ?? 'default'}. (applies on next message)`)
      }
      b.feed = typed.on
      this.d.store.saveRegistry()
      return void this.say(topicId, typed.on ? '🔎 Activity feed ON — one line per tool call.' : '🔎 Activity feed OFF.')
    }

    if (!b) return void this.send(topicId, 'This topic has no Claude session yet.', new InlineKeyboard().text('🆕 Start a session here', 'm:newhere'))
    await this.typing(topicId)
    if (!(await this.topics.sendToTopic(topicId, typed.text))) await this.say(topicId, 'No session bound to this topic. Use /new (or /attach) first.')
  }

  // ── wiring ───────────────────────────────────────────────────────────────

  private allowed(ctx: Context): boolean {
    return String(ctx.from?.id) === this.d.cfg.allowedUserId && String(ctx.chat?.id) === this.d.cfg.forumChatId
  }

  private wire(): void {
    const bot = this.bot
    bot.on('message:text', async ctx => {
      if (!this.allowed(ctx)) return void this.d.metrics.inc('rejected_updates')
      await this.handleText(ctx, ctx.message.text)
    })

    bot.on('message:photo', async ctx => {
      if (!this.allowed(ctx)) return void this.d.metrics.inc('rejected_updates')
      const topicId = this.topicIdOf(ctx)
      if (!topicId) return void this.say(undefined, 'Send images inside a session topic.')
      try {
        const best = ctx.message.photo[ctx.message.photo.length - 1]
        const path = this.d.files.saveInbox(`${best.file_unique_id}.jpg`, await this.download(best.file_id))
        const caption = ctx.message.caption?.trim()
        this.d.metrics.inc('files_received')
        await this.say(topicId, '🖼️ image received')
        await this.topics.sendToTopic(topicId, `The user sent an image, saved at ${path} — Read it to see it.${caption ? `\nCaption: ${caption}` : ''}`)
      } catch (e) {
        await this.say(topicId, `image handling failed: ${e}`)
      }
    })

    bot.on('message:document', async ctx => {
      if (!this.allowed(ctx)) return void this.d.metrics.inc('rejected_updates')
      const topicId = this.topicIdOf(ctx)
      if (!topicId) return void this.say(undefined, 'Send files inside a session topic.')
      const doc = ctx.message.document
      try {
        if (doc.file_size && doc.file_size > 20 * 1024 * 1024) {
          return void this.say(topicId, `File too large (${(doc.file_size / 1048576).toFixed(1)} MB) — Telegram caps bot downloads at 20 MB.`)
        }
        const name = doc.file_name || `${Date.now()}.bin`
        const path = this.d.files.saveInbox(name, await this.download(doc.file_id))
        const caption = ctx.message.caption?.trim()
        this.d.metrics.inc('files_received')
        await this.say(topicId, `📎 file received: ${name}`)
        await this.topics.sendToTopic(topicId, `The user sent a file "${name}" (${doc.mime_type ?? 'unknown type'}), saved at ${path} — Read it.${caption ? `\nCaption: ${caption}` : ''}`)
      } catch (e) {
        await this.say(topicId, `file handling failed: ${e}`)
      }
    })

    bot.on('callback_query:data', async ctx => {
      const data = ctx.callbackQuery.data || ''
      if (!this.allowed(ctx)) {
        this.d.metrics.inc('rejected_updates')
        return void ctx.answerCallbackQuery({ text: 'Not authorized.' }).catch(() => {})
      }
      if (data.startsWith('m:')) {
        this.menuCtx = ctx
        try {
          await this.handleMenu(ctx, data)
        } finally {
          this.menuCtx = undefined
        }
        return
      }
      const qm = /^qa:([0-9a-z]+):(\d+|done)$/.exec(data)
      if (qm) {
        const b = this.askBtns.get(qm[1])
        if (!b) return void ctx.answerCallbackQuery({ text: 'Expired.' }).catch(() => {})
        if (qm[2] === 'done') {
          this.askBtns.delete(qm[1])
          b.resolve([...b.selected].sort((a, z) => a - z).map(i => b.options[i].label))
          await ctx.answerCallbackQuery({ text: '✅ Submitted' }).catch(() => {})
          await bot.api.editMessageReplyMarkup(this.d.cfg.forumChatId, b.messageId, { reply_markup: undefined }).catch(() => {})
        } else if (b.multi) {
          const i = Number(qm[2])
          if (b.selected.has(i)) b.selected.delete(i)
          else b.selected.add(i)
          await bot.api.editMessageReplyMarkup(this.d.cfg.forumChatId, b.messageId, { reply_markup: askKeyboard(qm[1], b.options, true, b.selected) }).catch(() => {})
          await ctx.answerCallbackQuery({ text: b.selected.has(i) ? 'added' : 'removed' }).catch(() => {})
        } else {
          this.askBtns.delete(qm[1])
          const label = b.options[Number(qm[2])]?.label ?? ''
          b.resolve(label)
          await ctx.answerCallbackQuery({ text: `✓ ${label}`.slice(0, 200) }).catch(() => {})
          await bot.api.editMessageReplyMarkup(this.d.cfg.forumChatId, b.messageId, { reply_markup: undefined }).catch(() => {})
        }
        return
      }
      const m = /^p:([0-9a-z]+):(a|d)$/.exec(data)
      if (!m) return void ctx.answerCallbackQuery().catch(() => {})
      const entry = this.pending.get(m[1])
      if (!entry) return void ctx.answerCallbackQuery({ text: 'Expired.' }).catch(() => {})
      this.pending.delete(m[1])
      const allow = m[2] === 'a'
      this.d.metrics.inc(allow ? 'approvals_allowed' : 'approvals_denied')
      // No updatedInput on allow: the tool runs with its ORIGINAL input.
      entry.resolve(allow ? { behavior: 'allow' } : { behavior: 'deny', message: 'denied by user' })
      await ctx.answerCallbackQuery({ text: allow ? '✅ Allowed' : '❌ Denied' }).catch(() => {})
      if (entry.messageId) await bot.api.editMessageReplyMarkup(this.d.cfg.forumChatId, entry.messageId, { reply_markup: undefined }).catch(() => {})
    })

    bot.catch(err => {
      this.d.metrics.inc('bot_errors')
      this.d.log.error('bot.error', { error: err.error })
    })
  }
}

// ── helpers ────────────────────────────────────────────────────────────────

function summarizeInput(tool: string, input: Record<string, unknown>): string {
  if (tool === 'Bash' && typeof input.command === 'string') return `\n<code>${htmlEsc(input.command.slice(0, 300))}</code>`
  if ((tool === 'Write' || tool === 'Edit') && typeof input.file_path === 'string') return `\n<code>${htmlEsc(input.file_path)}</code>`
  const s = JSON.stringify(input)
  return `\n<code>${htmlEsc(s.length > 200 ? s.slice(0, 200) + '…' : s)}</code>`
}

function modelLinesText(cfg: Config): string {
  return cfg.catalog.enabled.map(k => `${modelLabel(cfg.catalog, cfg.catalog.ids[k])} → ${cfg.catalog.ids[k]}`).join('\n')
}

/** `/new <name…> [cwd=<path>] [auto]`: the rest of the line is the topic name. */
export function parseNew(args: string, fallbackCwd: string): { name: string; cwd: string; auto: boolean; notes: string[] } {
  const { existsSync, statSync } = require('fs') as typeof import('fs')
  const { homedir } = require('os') as typeof import('os')
  const { join } = require('path') as typeof import('path')
  let cwd = fallbackCwd
  let auto = false
  const kept: string[] = []
  const notes: string[] = []
  for (const t of args.trim().split(/\s+/).filter(Boolean)) {
    if (t.startsWith('cwd=')) {
      const raw = t.slice(4)
      const cand = raw.startsWith('~') ? join(homedir(), raw.slice(1)) : raw
      if (existsSync(cand) && statSync(cand).isDirectory()) cwd = cand
      else notes.push(`(ignoring cwd="${cand}" — not a directory; using ${fallbackCwd})`)
    } else if (t.toLowerCase() === 'auto') auto = true
    else kept.push(t)
  }
  return { name: kept.join(' ') || `session-${Date.now().toString(36)}`, cwd, auto, notes }
}

export function help(reposDir: string): string {
  return `Everything is buttons — you rarely need to type commands.

📋 GENERAL topic — send anything (or tap the blue Menu button) to open:
• 🆕 New session — pick a repo (from ${reposDir}), a model, an effort level, and approvals
• ⚡ Quick new — instant session in your default folder + model + effort
• 📋 My sessions — list past sessions; tap one to reopen it
• ▶️ Resume last — jump into the most recent session
• ⚙️ Settings — set the default model, effort + folder for new sessions
• 📊 Status — live sessions, counters, versions, recent errors
• ❓ Help — this text

💬 SESSION topic — just type your request. A 📌 pinned panel sits at the top of
every session topic with:
• 🐇 Haiku / ⚡ Sonnet / 🧠 Opus / ✨ Fable — switch model (applies next message)
• 🎚 low / med / high / xhigh / max / ↺ default — how hard it thinks (Haiku has none)
• 🔐 Approvals ↔ ⚡ Auto — toggle whether tools ask before running
• 🔎 Activity feed — one line per tool call (🖥 command, 📖 read, ✏️ edit, 🤖 subagent);
   on by default in ⚡ auto, where nothing else shows what the session is doing
• 💾 Close & keep — stop the session + close the topic, keep everything
   (a ♻️ Reopen button appears to resume later with full context)
• 🗑 Close & delete — remove the topic + session (transcript stays on disk)
• 🧹 Close, delete & remove all — wipe everything: topic, session, delivered
   files, and the transcript (no longer resumable)

Typed in a topic: use fable high · use opus · effort max · effort default · feed on · feed off

🖼️ Files both ways:
• Claude can send you images/files — they appear right in the topic.
• Send a photo or file into a topic and the session can read it.

❓ Questions & plans:
• Clarifying questions appear as tappable options (or type your own answer).
• A proposed plan is shown, then you tap ✅ Allow / ❌ Deny.
• Risky tools (Bash/Write/Edit/Web) ask ✅ Allow / ❌ Deny — unless ⚡ auto is on.`
}
