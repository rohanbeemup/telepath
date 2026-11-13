/**
 * The Telegram side: grammy handlers and the delivery of everything the user reads.
 * Decisions live in the modules this file calls (commands, wizard, keyboards,
 * interpret via TopicManager); this file is the plumbing between them and the
 * Telegram API, plus the permission prompts a session blocks on.
 */
import { Bot, InlineKeyboard, InputFile, type Api, type Context } from 'grammy'
import type { Message } from 'grammy/types'
import { autoRetry } from '@grammyjs/auto-retry'
import type { CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk'
import { basename } from 'path'
import type { Config } from './config'
import { admitted, allowedAction, membershipRequired, profileLocked, promptTapAllowed, Membership, type AccessConfig } from './access'
import { KNOWN_COMMANDS, parseTyped, type Typed } from './commands'
import type { Profile } from './profile'
import { parseTeamNew, TopicQuota, type Member } from './team'
import { describeTask } from './feed'
import { TurnStatus, type StatusTransport } from './status'
import { parseHandoff, resumePrompt } from './handoff'
import { deleteTranscript, listRepoFolders, type Files } from './files'
import { fallsBackToDocument, inboundFileName, inboundMediaNotice, mediaKind, MAX_DOWNLOAD_BYTES, type InboundKind } from './media'
import type { Event } from './interpret'
import type { Logger, Metrics } from './log'
import { htmlEsc, htmlToPlain, renderWithDeadline, chunkHtml, chunkPlain } from './markdown'
import { isEnabledModelKey, modelLabel, parseEffort, supportsEffort, MODEL_MENU, type Effort } from './models'
import { listSessions } from './session'
import { transcribe, TopicOrder, voiceTurn, type Heard } from './voice'
import { feedOn, type Binding, type Store } from './state'
import { isBusy, type SessionExtras, type TopicManager } from './topics'
import {
  approveKb,
  askKeyboard,
  backKb,
  controlsKb,
  mainMenuKb,
  openLinkKb,
  pagedListKb,
  pageSuffix,
  resumeKb,
  settingsKb,
  statusLiveKb,
  wrapConfirmKb,
  wrapConfirmText,
  settingsText,
  topicControlsKb,
  topicControlsText,
  wizardAutoKb,
  wizardEffortKb,
  wizardModelKb,
  type KbMode,
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
  /** The locked session profile, when one is configured (team mode requires it). */
  profile?: Profile
}

type Pending = { resolve: (r: PermissionResult) => void; topicId: string; messageId?: number }
type AskBtn = { topicId: string; multi: boolean; selected: Set<number>; options: { label: string; description?: string }[]; messageId: number; resolve: (v: string | string[]) => void }
const FREE_TEXT = Symbol('free-text')
/** A profile session has no file tool, so an inbound file has nowhere to go and the host path stays out of the chat. */
const TEXT_ONLY = '📎 This assistant reads text only: type your question. Voice notes are transcribed.'
const PROFILE_OWNS = '🔒 This install runs a profile: the model, effort and approvals are set there.'
/** grammy types its optional signal with the abort-controller polyfill; the platform's AbortSignal is what runs. */
type ApiSignal = NonNullable<Parameters<Api['getChatMember']>[2]>

export class TelegramBot {
  readonly bot: Bot
  private topics!: TopicManager
  private readonly pending = new Map<string, Pending>()
  private readonly askBtns = new Map<string, AskBtn>()
  private readonly askFreeText = new Map<string, (t: string) => void>()
  private readonly wizard = new Map<string, WizardState>()
  /** Per-topic order while a voice note is being transcribed in the background. */
  private readonly order = new TopicOrder()
  private defaultFolderChoices: string[] = []
  private tokenSeed = 0
  /** Set for the duration of a button tap so menu screens repaint the tapped message in place. */
  private menuCtx: Context | undefined
  /** One live "working" message per turn; driven by a 1 s tick from the daemon. */
  readonly status: TurnStatus
  /** Who may talk and who may change a topic (access.ts). */
  private readonly access: AccessConfig
  /** Team mode's second gate: the forum's own member list, asked per sender and cached. */
  private readonly membership: Membership
  /** Team mode: topics per member per day. */
  private readonly quota: TopicQuota

  constructor(private readonly d: BotDeps) {
    this.bot = new Bot(d.cfg.telegramToken)
    this.access = { teamMode: d.cfg.teamMode, allowedUserId: d.cfg.allowedUserId, forumChatId: d.cfg.forumChatId, adminUserIds: d.cfg.adminUserIds }
    // Capped: bot.start() handles updates one at a time, so one slow answer here would hold every topic.
    this.membership = new Membership(id => this.bot.api.getChatMember(d.cfg.forumChatId, Number(id), AbortSignal.timeout(5_000) as unknown as ApiSignal))
    this.quota = new TopicQuota(d.cfg.teamTopicsPerDay)
    // Every API call waits out a 429 for exactly the `retry_after` Telegram names (up to
    // 30 s, three attempts) instead of failing, so a burst of answers across topics is
    // delayed rather than lost. The status message has its own budget on top of this.
    this.bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 30 }))
    this.status = new TurnStatus(this.statusTransport())
    this.wire()
  }

  attachTopics(topics: TopicManager): void {
    this.topics = topics
  }

  /**
   * The status message's transport over the Bot API, with Telegram's answers mapped to
   * what TurnStatus needs: a 429 carries `retry_after` (honoured exactly), "message is
   * not modified" is a success, and a message the user deleted is `gone`.
   */
  private statusTransport(): StatusTransport {
    const chat = this.d.cfg.forumChatId
    const describe = (e: unknown): { code?: number; text: string; retryAfter?: number } => {
      const any = e as { error_code?: number; description?: string; parameters?: { retry_after?: number }; message?: string }
      return { code: any?.error_code, text: String(any?.description ?? any?.message ?? e), retryAfter: any?.parameters?.retry_after }
    }
    return {
      create: async (topicId, text, kind) => {
        try {
          const sent = await this.bot.api.sendMessage(chat, text, {
            message_thread_id: Number(topicId),
            disable_notification: true,
            ...(kind === 'live' ? { reply_markup: statusLiveKb() } : {}),
          })
          this.d.metrics.inc('status_created')
          return sent.message_id
        } catch (e) {
          this.d.log.warn('status.create_failed', { topic: topicId, error: e })
          return undefined
        }
      },
      edit: async (topicId, messageId, text, kind) => {
        try {
          // The markup is stated on every edit: the live text re-sends its button, the
          // summary clears it explicitly rather than relying on an omitted field to do so.
          await this.bot.api.editMessageText(chat, messageId, text, { reply_markup: kind === 'live' ? statusLiveKb() : { inline_keyboard: [] } })
          this.d.metrics.inc('status_edits')
          return { ok: true }
        } catch (e) {
          const d = describe(e)
          if (/not modified/i.test(d.text)) return { ok: true }
          if (d.code === 429) {
            this.d.metrics.inc('status_edit_429')
            this.d.log.warn('status.edit_rate_limited', { topic: topicId, retryAfter: d.retryAfter })
            return { ok: false, retryAfterMs: (d.retryAfter ?? 5) * 1000 }
          }
          if (d.code === 400 && /message (to edit )?not found|can't be edited|MESSAGE_ID_INVALID/i.test(d.text)) return { ok: false, gone: true }
          this.d.log.warn('status.edit_failed', { topic: topicId, error: d.text })
          return { ok: false }
        }
      },
      remove: async (topicId, messageId) => {
        await this.bot.api.deleteMessage(chat, messageId).catch(() => {})
      },
      type: async topicId => {
        await this.bot.api.sendChatAction(chat, 'typing', { message_thread_id: Number(topicId) }).catch(() => {})
      },
    }
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
    if (topicId) this.status.bump(topicId) // the status must stay the last message
  }

  /** Plain send (menus, notices, feed). */
  async send(topicId: string | undefined, text: string, kb?: InlineKeyboard): Promise<void> {
    const opts: Record<string, unknown> = topicId ? { message_thread_id: Number(topicId) } : {}
    if (kb) opts.reply_markup = kb
    try {
      await this.bot.api.sendMessage(this.d.cfg.forumChatId, text, opts)
      if (topicId) this.status.bump(topicId)
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
        // Into the turn's live status message; interpret() already gated on feedOn.
        this.d.metrics.inc('feed_items', ev.items.length)
        this.status.addItems(topicId, ev.items)
        return
      case 'sessionId': {
        if (this.d.cfg.teamMode) return // a group needs no resume line, and the host's paths stay out of the chat
        const cwd = b?.cwd ?? this.d.cfg.defaultCwd
        await this.say(topicId, `🆔 Session id: ${ev.id}\nResume on laptop:\ncd ${cwd} && claude --resume ${ev.id}`)
        return
      }
      case 'turn':
        if (ev.phase === 'start') this.status.begin(topicId, ev.inFlight, b ? feedOn(b) : false)
        else if (ev.phase === 'waiting') this.status.waiting(topicId, ev.note)
        else if (ev.outcome === 'wrapped') {
          // A wrap-up closes its status whatever is still queued; the queued turns, which the
          // CLI already holds, get a fresh status of their own.
          await this.status.finish(topicId, 'wrapped')
          if (ev.inFlight > 0) this.status.begin(topicId, ev.inFlight, b ? feedOn(b) : false)
        } else if (ev.inFlight > 0) this.status.turnEnded(topicId, ev.inFlight, ev.outcome) // more turns queued: keep the status open
        else await this.status.finish(topicId, ev.outcome)
        return
      case 'wrapped': {
        // The hand-off text itself arrived as a normal answer; this is the verdict plus the
        // way back in.
        if (ev.handoff) await this.send(topicId, '⏹ Wrapped up. Tap ▶️ to continue from the hand-off, or just type what to do next.', resumeKb())
        else await this.send(topicId, '⏹ Wrapped up, but the session wrote no hand-off in the expected shape. Its last message above is what it left; type what to do next.')
        return
      }
      case 'turnEnd':
        await this.flushOutbox(topicId)
        return
      case 'turnError': {
        await this.flushOutbox(topicId)
        if (ev.afterRateLimit) return // the friendlier rate-limit notice was already shown
        const detail = ev.errors.length ? `\n${ev.errors.map(e => e.slice(0, 300)).join('\n')}` : ''
        if (this.d.profile) {
          // Nothing to switch under a profile; a spent budget is said now, not at the next message.
          const budget = ev.subtype === 'error_max_budget_usd' ? '\n💸 This topic has used its budget. Open a new topic for the next question.' : ''
          await this.send(topicId, `⚠️ turn ended: ${ev.subtype}.${detail}${budget}`)
          return
        }
        await this.send(topicId, `⚠️ turn ended: ${ev.subtype}.${detail}\nTap ⚙️ to switch model or adjust this session.`, controlsKb())
        return
      }
      case 'task': {
        const line = describeTask(ev.status, ev.description, ev.background)
        if (ev.status === 'started') {
          if (b && feedOn(b)) this.status.addItems(topicId, [{ kind: 'task', label: line }])
        } else {
          // A settled background task is always surfaced as its own message: the SDK
          // re-invokes the model with the result, but if that continuation is
          // rate-limited the user would never hear.
          await this.send(topicId, line)
        }
        return
      }
      case 'denied':
        await this.send(topicId, `🚫 ${ev.tool} was denied: ${ev.message}`)
        return
      case 'assistantError':
        this.d.metrics.inc('assistant_errors')
        if (this.d.profile) await this.send(topicId, `⚠️ model error: ${ev.error}.`)
        else await this.send(topicId, `⚠️ model error: ${ev.error}. Tap ⚙️ to switch model or adjust this session.`, controlsKb())
        return
      case 'state':
        // The stream ended (close, eviction, crash): a turn that never got its result must
        // not leave a "Working" message behind.
        if (ev.state === 'idle') await this.status.finish(topicId, 'stopped')
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
    this.status.bump(topicId)
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
      .then(sent => {
        this.status.bump(topicId)
        return new Promise<string | string[]>(resolve => this.askBtns.set(token, { topicId, multi, selected, options, messageId: sent.message_id, resolve }))
      })
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
    const chat = this.d.cfg.forumChatId
    const opts = { message_thread_id: Number(topicId), caption: basename(path) }
    const kind = mediaKind(path)
    // A fresh InputFile per attempt: a consumed file stream cannot be replayed on fallback.
    const sendTyped = async (): Promise<void> => {
      switch (kind) {
        case 'image':
          await this.bot.api.sendPhoto(chat, new InputFile(path), opts)
          break
        case 'video':
          await this.bot.api.sendVideo(chat, new InputFile(path), { ...opts, supports_streaming: true })
          break
        case 'animation':
          await this.bot.api.sendAnimation(chat, new InputFile(path), opts)
          break
        case 'audio':
          await this.bot.api.sendAudio(chat, new InputFile(path), opts)
          break
        default:
          await this.bot.api.sendDocument(chat, new InputFile(path), opts)
      }
    }
    try {
      try {
        await sendTyped()
      } catch (e) {
        // Telegram rejects formats outside its inline set (e.g. wav/flac, mkv/mov); deliver
        // them as a document rather than leaving the file stuck in the outbox forever.
        if (!fallsBackToDocument(kind)) throw e
        this.d.log.warn('media.typed_send_failed', { topic: topicId, path, kind, error: e })
        await this.bot.api.sendDocument(chat, new InputFile(path), opts)
      }
      this.d.metrics.inc('files_sent')
      this.status.bump(topicId)
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

  /** Typed text, photos, files and video wait behind a voice note still being transcribed in their
   *  topic. Otherwise they run directly: bot.start() awaits each update before the next (grammY's
   *  handleUpdates), so a message handled here is in its session's queue before any later update,
   *  a voice note included, is looked at. A concurrent runner (@grammyjs/runner) would void this
   *  and need every message queued. */
  private async inOrder(ctx: Context, fn: () => Promise<void>): Promise<void> {
    const key = this.topicIdOf(ctx) ?? 'general'
    if (!this.order.busy(key)) return fn()
    this.order.queue(key, fn, e => this.d.log.error('message.failed', { topic: key, error: e }))
  }

  /** A voice note becomes the words in it, then goes the way typed text does. Any failure is said in the topic. */
  private async handleVoice(ctx: Context, topicId: string, media: { file_id: string; file_unique_id: string; file_size?: number; file_name?: string }, shared: Omit<Heard, 'words'>): Promise<void> {
    try {
      if (media.file_size && media.file_size > MAX_DOWNLOAD_BYTES) {
        return await this.say(topicId, `🎙️ Voice note too large (${(media.file_size / 1048576).toFixed(1)} MB): Telegram caps bot downloads at 20 MB.`)
      }
      if (topicId) await this.typing(topicId)
      const path = this.d.files.saveInbox(media.file_name || `${media.file_unique_id}.ogg`, await this.download(media.file_id))
      const words = await transcribe(path, this.d.cfg.transcribeCmd)
      this.d.metrics.inc('voice_notes')
      const turn = voiceTurn({ words, ...shared })
      if (!shared.forwarded && !shared.audioFile) {
        // the user's own voice note: their turn, as if typed (commands included)
        await this.say(topicId, `🎙️ ${words}`)
        return await this.handleText(ctx, turn)
      }
      await this.say(topicId, `🎙️ ${shared.audioFile ? 'Audio file' : 'Forwarded voice note'}, passed on as content: ${words}`)
      if (!this.d.store.registry[topicId] && this.d.cfg.teamMode && !(await this.bindFreshProfileTopic(ctx, topicId))) return
      if (!(await this.topics.sendToTopic(topicId, turn))) await this.say(topicId, 'No session bound to this topic. Use /new (or /attach) first.')
    } catch (e) {
      await this.say(topicId, `🎙️ Voice note not transcribed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /** Download an inbound video / GIF / video note upload and tell the session where it landed.
   *  Voice and audio go through handleVoice (transcription) instead. */
  private async handleIncomingMedia(ctx: Context, kind: InboundKind): Promise<void> {
    const topicId = this.topicIdOf(ctx)
    if (!topicId) return void this.say(undefined, 'Send media inside a session topic.')
    if (this.d.profile) return void this.say(topicId, TEXT_ONLY)
    this.status.bump(topicId)
    const m = ctx.message
    const src = kind === 'video' ? m?.video : kind === 'animation' ? m?.animation : m?.video_note
    if (!src) return
    try {
      if (src.file_size && src.file_size > MAX_DOWNLOAD_BYTES) {
        return void this.say(
          topicId,
          `File too large (${(src.file_size / 1048576).toFixed(1)} MB) — Telegram caps bot downloads at 20 MB.`,
        )
      }
      const name = inboundFileName(kind, src)
      const path = this.d.files.saveInbox(name, await this.download(src.file_id))
      const mime = 'mime_type' in src ? src.mime_type : undefined
      const caption = m?.caption?.trim()
      this.d.metrics.inc('files_received')
      const notice = inboundMediaNotice(kind, { path, name, mime, duration: src.duration, caption })
      await this.say(topicId, notice.ack)
      await this.topics.sendToTopic(topicId, notice.prompt)
    } catch (e) {
      await this.say(topicId, `media handling failed: ${e}`)
    }
  }

  private async download(fileId: string): Promise<Uint8Array> {
    const file = await this.bot.api.getFile(fileId)
    const url = `https://api.telegram.org/file/bot${this.d.cfg.telegramToken}/${file.file_path}`
    // a hung download would otherwise hold its topic's queue forever
    return new Uint8Array(await (await fetch(url, { signal: AbortSignal.timeout(120_000) })).arrayBuffer())
  }

  // ── topics: create / bind / controls ─────────────────────────────────────

  private topicIdOf(ctx: Context): string | undefined {
    const id = ctx.message?.message_thread_id ?? ctx.callbackQuery?.message?.message_thread_id
    return id ? String(id) : undefined
  }

  private senderId(ctx: Context): string | undefined {
    return ctx.from ? String(ctx.from.id) : undefined
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
      const sent = await this.bot.api.sendMessage(this.d.cfg.forumChatId, topicControlsText(this.d.cfg.catalog, b, undefined, this.kbMode()), {
        message_thread_id: Number(topicId),
        reply_markup: topicControlsKb(this.d.cfg.catalog, b, this.kbMode()),
      })
      b.controlMsgId = sent.message_id
      this.d.store.saveRegistry()
      // Pin non-silently: the event is what makes mobile Telegram show the per-topic pin bar.
      await this.bot.api.pinChatMessage(this.d.cfg.forumChatId, sent.message_id).catch(e => this.d.log.warn('pin.failed', { topic: topicId, error: e }))
    } catch (e) {
      this.d.log.error('controls.post_failed', { topic: topicId, error: e })
    }
  }

  /** The wrap-up confirmation, with the queue count from the live session. */
  private async offerWrapUp(topicId: string): Promise<void> {
    const live = this.topics.live.get(topicId)
    if (!live || !isBusy(live)) return this.send(topicId, 'Nothing is running in this topic right now, so there is nothing to wrap up.')
    await this.send(topicId, wrapConfirmText(live.queued), wrapConfirmKb())
  }

  private async repaintControls(topicId: string, b: Binding, note?: string): Promise<void> {
    await this.paint(topicId, topicControlsText(this.d.cfg.catalog, b, note, this.kbMode()), topicControlsKb(this.d.cfg.catalog, b, this.kbMode()))
  }

  /**
   * ⚙️ from a notice: refresh the pinned panel itself, never the notice the button sat
   * on, and never a re-post (a re-post re-pins, and a pin notifies the whole forum).
   */
  private async refreshPinnedControls(topicId: string, b: Binding): Promise<void> {
    if (b.controlMsgId) {
      try {
        await this.bot.api.editMessageText(this.d.cfg.forumChatId, b.controlMsgId, topicControlsText(this.d.cfg.catalog, b, undefined, this.kbMode()), {
          reply_markup: topicControlsKb(this.d.cfg.catalog, b, this.kbMode()),
        })
        return
      } catch (e) {
        if (/not modified/i.test(String((e as { description?: string })?.description ?? e))) return
      }
    }
    await this.postPinnedControls(topicId)
  }

  private kbMode(): KbMode {
    return { team: this.d.cfg.teamMode, profile: !!this.d.profile }
  }

  private memberOf(ctx: Context): Member {
    return { firstName: ctx.from?.first_name, username: ctx.from?.username }
  }

  /** A topic opened without a title: the member and the time. */
  private defaultTitle(ctx: Context): string {
    return parseTeamNew('', this.memberOf(ctx), new Date()).title
  }

  /** The topic's own name, carried by messages that reply to its creation. */
  private topicTitleOf(ctx: Context): string | undefined {
    return ctx.message?.reply_to_message?.forum_topic_created?.name
  }

  /**
   * Team mode: each member may open only so many topics a day. Reserves the opening
   * (synchronously, so two in flight cannot both pass) and says so when the allowance is
   * spent; a creation Telegram then refuses is given back with refundTopic.
   */
  private async reserveTopic(ctx: Context, where: string | undefined): Promise<boolean> {
    const uid = this.senderId(ctx)
    if (!membershipRequired(this.access, uid)) return true // the cap is a member's; admins and single users are exempt
    if (uid && this.quota.take(uid)) return true
    this.d.metrics.inc('topic_quota_refused')
    await this.say(where, `🧮 You have opened ${this.d.cfg.teamTopicsPerDay} topics today, the daily allowance. Keep asking in one of them, or come back tomorrow.`)
    return false
  }

  private refundTopic(ctx: Context): void {
    const uid = this.senderId(ctx)
    if (uid && membershipRequired(this.access, uid)) this.quota.refund(uid)
  }

  /** A fresh topic a member typed or spoke into: bound to the profile, within the allowance, once. */
  private async bindFreshProfileTopic(ctx: Context, topicId: string): Promise<boolean> {
    if (!(await this.reserveTopic(ctx, topicId))) return false
    if (this.d.store.registry[topicId]) {
      // Bound meanwhile (a 🆕 tap and a transcribed voice note can both get here): one topic, one binding, one charge.
      this.refundTopic(ctx)
      return true
    }
    this.bindProfileTopic(topicId, this.topicTitleOf(ctx) ?? this.defaultTitle(ctx))
    await this.postPinnedControls(topicId)
    return true
  }

  /**
   * With a profile: a topic binds to it, never to a folder, model or approval choice. No
   * session is opened here; the first message opens one, so a topic nobody writes in
   * costs no process.
   */
  private bindProfileTopic(topicId: string, title: string): void {
    const p = this.d.profile
    const { prefs } = this.d.store
    this.bind(topicId, { cwd: p?.cwd ?? this.d.store.defaultCwd(), model: p?.model ?? prefs.defaultModel, effort: p?.effort ?? prefs.defaultEffort, title, auto: false })
    this.d.metrics.inc('topics_created')
  }

  /**
   * /new, 🆕 and ⚡ with a profile: one path, within the allowance. A tap's outcome paints
   * the tapped menu; typed or spoken text gets a fresh message, because the voice path
   * runs outside the update loop and the shared menu context may be another member's.
   */
  private async createProfileTopic(ctx: Context, title: string, intoTopic: string | undefined, via: 'tap' | 'text'): Promise<void> {
    const tell = (text: string, kb?: InlineKeyboard): Promise<void> => (via === 'tap' ? this.paint(intoTopic, text, kb) : this.send(intoTopic, text, kb))
    if (!(await this.reserveTopic(ctx, intoTopic))) return
    let topicId: string
    try {
      topicId = await this.createTopic(title)
    } catch (e) {
      this.refundTopic(ctx) // only an opening that happened counts
      return tell(`Couldn't create topic (is the bot admin with Manage Topics?): ${e}`, backKb())
    }
    this.bindProfileTopic(topicId, title)
    await this.postPinnedControls(topicId)
    await tell(`✅ Created "${title}".`, openLinkKb(this.d.cfg.forumChatId, topicId))
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
    await this.paint(topicId, '👋 What would you like to do?', mainMenuKb(this.kbMode()))
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
      if (this.d.profile) {
        // No wizard: the profile decides everything but the title.
        if (data === 'm:newhere' && topicId) {
          if (store.registry[topicId]) return void ack('Already a conversation')
          await ack('Starting…')
          // Queued behind this topic's transcription, so a voice note and this tap bind it once.
          return this.inOrder(ctx, async () => {
            if (!store.registry[topicId]) await this.bindFreshProfileTopic(ctx, topicId)
          })
        }
        await ack('Creating…')
        return this.createProfileTopic(ctx, this.defaultTitle(ctx), topicId, 'tap')
      }
      await ack()
      this.wizard.set(uid, startWizard(listRepoFolders(this.d.cfg.reposDir, store.defaultCwd()), data === 'm:newhere' ? topicId : undefined))
      return this.renderWizard(uid, topicId)
    }
    if (data === 'm:quick') {
      await ack('Creating…')
      if (this.d.profile) return this.createProfileTopic(ctx, this.defaultTitle(ctx), topicId, 'tap')
      const cwd = store.defaultCwd()
      const tid = await this.newSession(basename(cwd), cwd, store.prefs.defaultModel, store.prefs.defaultEffort, false, topicId)
      if (tid) await this.paint(topicId, `✅ Created "${basename(cwd)}".`, openLinkKb(this.d.cfg.forumChatId, tid))
      return
    }
    if (data === 'm:list') return void (await ack(), this.showSessions(topicId, 0))
    if (data === 'm:resume') {
      if (this.d.profile) return void ack('Not under a profile: every topic starts fresh')
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
    if (data === 'm:status') {
      await ack()
      // The status lists every topic, the admin ids and recent errors: in team mode it stays in General.
      if (this.d.cfg.teamMode && topicId) return this.paint(topicId, '📊 Status is shown in General only: it lists every topic.', backKb())
      return this.paint(topicId, this.d.statusText(), backKb())
    }
    if (data === 'm:help') return void (await ack(), this.send(topicId, this.d.cfg.teamMode ? teamHelp() : help(this.d.cfg.reposDir), backKb()))
    if (data === 'm:cancel') {
      this.wizard.delete(uid)
      await ack('Cancelled')
      return this.showMainMenu(topicId)
    }
    if (data === 'm:ctl') {
      await ack()
      const cb = topicId ? store.registry[topicId] : undefined
      return topicId && cb ? this.refreshPinnedControls(topicId, cb) : this.showMainMenu(topicId)
    }

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
      if (this.d.profile) return void ack('Not under a profile: every topic starts fresh')
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
    if (data === 'm:twrap') {
      await ack()
      return this.offerWrapUp(topicId)
    }
    const tw = /^m:tw:(now|turn)$/.exec(data)
    if (tw) {
      const ok = this.topics.wrapUp(topicId, { when: tw[1] === 'turn' ? 'after-turn' : 'now' })
      await ack(ok ? '⏹ Wrapping up…' : 'Nothing is running')
      if (!ok) return this.send(topicId, 'Nothing is running in this topic right now, so there is nothing to wrap up.')
      return this.paint(topicId, tw[1] === 'turn' ? '⏳ Wrapping up after this turn: the session finishes what it is doing, then writes a hand-off.' : '⏹ Wrapping up: the session finishes its current step, then writes a hand-off.')
    }
    if (data === 'm:tres') {
      const hb = this.d.store.registry[topicId]
      const h = hb?.handoff ? parseHandoff(hb.handoff.text) : undefined
      if (!h) return void ack('No hand-off saved for this topic')
      await ack('▶️ Resuming')
      await this.topics.sendToTopic(topicId, resumePrompt(h))
      return
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
      if (b && this.d.cfg.teamMode) {
        b.closed = true // no session opens here until an admin's ♻️ Reopen; a single user's kept topic resumes on its next message
        store.saveRegistry()
      }
      void this.status.drop(topicId)
      if (b?.controlMsgId) await this.bot.api.unpinChatMessage(this.d.cfg.forumChatId, b.controlMsgId).catch(() => {})
      await ack('💾 Closed')
      await this.paint(topicId, '💾 Session closed and saved — your context is kept. Reopen to resume.', new InlineKeyboard().text('♻️ Reopen & resume', 'm:treopen'))
      await this.bot.api.closeForumTopic(this.d.cfg.forumChatId, Number(topicId)).catch(e => this.d.log.warn('topic.close_failed', { topic: topicId, error: e }))
      return
    }
    if (data === 'm:treopen') {
      await this.bot.api.reopenForumTopic(this.d.cfg.forumChatId, Number(topicId)).catch(e => this.d.log.warn('topic.reopen_failed', { topic: topicId, error: e }))
      if (!b) return void this.paint(topicId, 'That session no longer exists.', backKb())
      b.closed = false
      store.saveRegistry()
      const live = this.topics.ensureLive(topicId)
      await ack(live ? '♻️ Reopened' : '♻️ Reopened, but no session could open (budget spent?)')
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
    void this.status.drop(topicId)
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
    const parsed = parseTyped(raw, this.d.cfg.catalog, ctx.me?.username)
    if (parsed.kind === 'foreign') return // another bot's command
    // Under a profile, "use opus" or "effort high" configure nothing: they are what the user said.
    const typed: Typed = this.d.profile && (parsed.kind === 'use' || parsed.kind === 'effort') ? { kind: 'chat', text: raw.trim() } : parsed
    this.d.log.debug('in.text', { topic: topicId ?? 'general', kind: typed.kind, len: raw.length })

    const fromId = this.senderId(ctx)
    const refuse = (): Promise<void> => {
      this.d.metrics.inc('admin_only_refused')
      return this.say(topicId, '🔒 Admins only.')
    }

    if (typed.kind === 'slash') {
      // An unknown command (/start, a typo) is nobody's to refuse: the menu, or silence in a team's General.
      if (!KNOWN_COMMANDS.has(typed.cmd)) {
        if (!topicId && this.d.cfg.teamMode) return
        return this.showMainMenu(topicId)
      }
      if (!allowedAction(this.access, fromId, `/${typed.cmd}`)) return refuse()
      if (this.d.profile && profileLocked(`/${typed.cmd}`)) return void this.say(topicId, PROFILE_OWNS)
      switch (typed.cmd) {
        case 'new': {
          if (this.d.profile) return this.createProfileTopic(ctx, parseTeamNew(typed.args, this.memberOf(ctx), new Date()).title, topicId, 'text')
          const { name, cwd, auto, notes } = parseNew(typed.args, this.d.store.defaultCwd())
          for (const n of notes) await this.say(topicId, n)
          await this.newSession(name, cwd, this.d.store.prefs.defaultModel, this.d.store.prefs.defaultEffort, auto, topicId)
          return
        }
        case 'list':
          return this.showSessions(topicId, 0)
        case 'attach': {
          // An old transcript may hold a full session's tool results, and its saved cost is not this topic's.
          if (this.d.profile) return void this.say(topicId, '🔒 Not under a profile: every topic starts fresh.')
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
          if (this.d.cfg.teamMode && topicId) return void this.say(topicId, '📊 Status is shown in General only: it lists every topic.')
          return void this.send(topicId, this.d.statusText())
        case 'menu': {
          const mb = topicId ? this.d.store.registry[topicId] : undefined
          return topicId && mb ? this.refreshPinnedControls(topicId, mb) : this.showMainMenu(topicId)
        }
        case 'help':
          return void this.say(topicId, this.d.cfg.teamMode ? teamHelp() : help(this.d.cfg.reposDir))
        default:
          return this.showMainMenu(topicId)
      }
    }

    if (!topicId) {
      if (this.d.cfg.teamMode) return // General is the members' own; the bot answers commands there, not chatter
      return this.showMainMenu(undefined) // plain text in General → the menu
    }

    // A pending clarifying question takes any typed reply as its free-text answer, before
    // the admin gate: the answer is the session's, whatever words it happens to be.
    const ft = this.askFreeText.get(topicId)
    if (ft) return void ft(raw)

    if (!allowedAction(this.access, fromId, typed.kind)) return refuse()

    let b = this.d.store.registry[topicId]
    if (typed.kind === 'wrap') return this.offerWrapUp(topicId)
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

    if (!b) {
      if (!this.d.cfg.teamMode) return void this.send(topicId, 'This topic has no Claude session yet.', new InlineKeyboard().text('🆕 Start a session here', 'm:newhere'))
      if (!(await this.bindFreshProfileTopic(ctx, topicId))) return
      b = this.d.store.registry[topicId]
    }
    this.status.bump(topicId) // the user's own message now sits below the status
    await this.typing(topicId)
    if (!(await this.topics.sendToTopic(topicId, typed.text))) await this.say(topicId, 'No session bound to this topic. Use /new (or /attach) first.')
  }

  // ── wiring ───────────────────────────────────────────────────────────────

  private allowed(ctx: Context): boolean {
    return admitted(this.access, { fromId: this.senderId(ctx), chatId: ctx.chat ? String(ctx.chat.id) : undefined, anonymous: !!ctx.message?.sender_chat })
  }

  /**
   * The chat gate, then in team mode the forum's own member list for everyone but the
   * configured admins. A lookup that failed is a no, said once per grace so a Telegram
   * blip reads as a blip and not as a dead bot.
   */
  private async admit(ctx: Context): Promise<boolean> {
    if (!this.allowed(ctx)) return false
    const uid = this.senderId(ctx)
    if (!membershipRequired(this.access, uid)) return true
    if (!uid) return false
    const verdict = await this.membership.check(uid)
    if (verdict === 'member') return true
    this.d.metrics.inc(verdict === 'unknown' ? 'membership_unknown' : 'non_member_rejected')
    if (verdict === 'unknown' && this.membership.noticeDue(uid)) await this.say(this.topicIdOf(ctx), '⚠️ Could not verify your membership just now. Try again in a moment.')
    return false
  }

  private wire(): void {
    const bot = this.bot
    bot.on('message:text', async ctx => {
      if (!(await this.admit(ctx))) return void this.d.metrics.inc('rejected_updates')
      await this.inOrder(ctx, () => this.handleText(ctx, ctx.message.text))
    })

    bot.on('message:photo', async ctx => {
      if (!(await this.admit(ctx))) return void this.d.metrics.inc('rejected_updates')
      await this.inOrder(ctx, async () => {
        const topicId = this.topicIdOf(ctx)
        if (!topicId) return await this.say(undefined, 'Send images inside a session topic.')
        if (this.d.profile) return await this.say(topicId, TEXT_ONLY)
        this.status.bump(topicId)
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
    })

    // Registered before message:document: Telegram animation (GIF) messages also carry a legacy
    // document field, so the document handler would otherwise claim them first. Each waits behind a
    // transcribing voice note in its topic (inOrder), as the other media handlers do.
    bot.on('message:video', async ctx => {
      if (!(await this.admit(ctx))) return void this.d.metrics.inc('rejected_updates')
      await this.inOrder(ctx, () => this.handleIncomingMedia(ctx, 'video'))
    })
    bot.on('message:animation', async ctx => {
      if (!(await this.admit(ctx))) return void this.d.metrics.inc('rejected_updates')
      await this.inOrder(ctx, () => this.handleIncomingMedia(ctx, 'animation'))
    })
    bot.on('message:video_note', async ctx => {
      if (!(await this.admit(ctx))) return void this.d.metrics.inc('rejected_updates')
      await this.inOrder(ctx, () => this.handleIncomingMedia(ctx, 'video_note'))
    })

    bot.on('message:document', async ctx => {
      if (!(await this.admit(ctx))) return void this.d.metrics.inc('rejected_updates')
      await this.inOrder(ctx, async () => {
        const topicId = this.topicIdOf(ctx)
        if (!topicId) return await this.say(undefined, 'Send files inside a session topic.')
        if (this.d.profile) return await this.say(topicId, TEXT_ONLY)
        this.status.bump(topicId)
        const doc = ctx.message.document
        try {
          if (doc.file_size && doc.file_size > MAX_DOWNLOAD_BYTES) {
            return await this.say(topicId, `File too large (${(doc.file_size / 1048576).toFixed(1)} MB) — Telegram caps bot downloads at 20 MB.`)
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
    })

    // Transcription takes 20 s or more on a CPU, and updates are handled one at a time, so it runs
    // in the background: awaiting it here would hold up every other message in every topic.
    bot.on(['message:voice', 'message:audio'], async ctx => {
      if (!(await this.admit(ctx))) return void this.d.metrics.inc('rejected_updates')
      const media = ctx.message.voice ?? ctx.message.audio
      if (!media) return
      const topicId = this.topicIdOf(ctx)
      if (!topicId) return await this.say(undefined, 'Send voice notes inside a session topic.')
      this.status.bump(topicId)
      const shared = {
        audioFile: !ctx.message.voice,
        forwarded: originName(ctx.message.forward_origin),
        caption: ctx.message.caption?.trim() || undefined,
      }
      // queued per topic, so whatever is sent after the note is handled after it
      this.order.queue(topicId, () => this.handleVoice(ctx, topicId, media, shared),
        e => this.d.log.error('voice.failed', { topic: topicId, error: e }))
    })

    bot.on('callback_query:data', async ctx => {
      const data = ctx.callbackQuery.data || ''
      if (!(await this.admit(ctx))) {
        this.d.metrics.inc('rejected_updates')
        return void ctx.answerCallbackQuery({ text: 'Not authorized.' }).catch(() => {})
      }
      if (data.startsWith('m:') && !allowedAction(this.access, this.senderId(ctx), data)) {
        this.d.metrics.inc('admin_only_refused')
        return void ctx.answerCallbackQuery({ text: '🔒 Admins only.' }).catch(() => {})
      }
      if (data.startsWith('m:') && this.d.profile && profileLocked(data)) return void ctx.answerCallbackQuery({ text: 'Set in the profile.' }).catch(() => {})
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
        if (!promptTapAllowed(this.access, { fromId: this.senderId(ctx), kind: 'question', sameTopic: this.topicIdOf(ctx) === b.topicId })) {
          return void ctx.answerCallbackQuery({ text: 'Not yours to answer.' }).catch(() => {})
        }
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
      if (!promptTapAllowed(this.access, { fromId: this.senderId(ctx), kind: 'approval', sameTopic: this.topicIdOf(ctx) === entry.topicId })) {
        return void ctx.answerCallbackQuery({ text: '🔒 Admins only.' }).catch(() => {})
      }
      this.pending.delete(m[1])
      const allow = m[2] === 'a'
      this.d.metrics.inc(allow ? 'approvals_allowed' : 'approvals_denied')
      // No updatedInput on allow: the tool runs with its ORIGINAL input.
      entry.resolve(allow ? { behavior: 'allow' } : { behavior: 'deny', message: 'denied by user' })
      await ctx.answerCallbackQuery({ text: allow ? '✅ Allowed' : '❌ Denied' }).catch(() => {})
      if (entry.messageId) await bot.api.editMessageReplyMarkup(this.d.cfg.forumChatId, entry.messageId, { reply_markup: undefined }).catch(() => {})
    })

    // The forum reports a membership change: that user's cached answer is dropped, so a
    // member removed just now is refused on their next message rather than at the TTL.
    bot.on('chat_member', ctx => {
      if (String(ctx.chat.id) !== this.d.cfg.forumChatId) return
      this.membership.forget(String(ctx.chatMember.new_chat_member.user.id))
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

/** Who a forwarded message came from, for framing it as shared content; undefined when not forwarded. */
function originName(o: Message['forward_origin']): string | undefined {
  if (!o) return undefined
  if (o.type === 'user') return [o.sender_user.first_name, o.sender_user.last_name].filter(Boolean).join(' ')
  if (o.type === 'hidden_user') return o.sender_user_name
  return o.type === 'chat' ? (o.sender_chat.title ?? 'a chat') : (o.chat.title ?? 'a channel')
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

/** Team mode's help: what a member can do, and nothing about folders, models or approvals. */
export function teamHelp(): string {
  return `This group shares one assistant. Every topic is a conversation anyone here can read and join.

• Open a new topic and ask your question there — or tap 🆕 New topic in General, or type /new <title>.
• Keep asking in the same topic to continue; open another topic for another subject.
• 🎙️ A voice note is transcribed and answered like typed text (where the install supports it).
• ⏹ Wrap up on the status message stops a long answer at its next step; ▶️ Resume picks it up again.
• 🔎 Activity feed on the pinned panel shows which tools an answer used.

Closing, deleting or wiping a topic, and changing the model, are for the admins.`
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
• 🔎 Activity feed — whether the turn's live status message also lists what the
   session did: 🖥 commands and 🤖 subagents by their description, ✏️ edits as one
   counted line, reads as a count; on by default in ⚡ auto

⏳ Every turn shows one live status message ("Working · 1:42 · 9 tool calls"), updated
every few seconds while Claude works, ending in a one-line summary. Answers, questions
and approvals always arrive as new messages, so your phone still notifies you.
• ⏹ Wrap up (on the status message, or type "wrap up" / "stop") — the session finishes
   its current step, writes a hand-off (done · open · how to resume) and stops; nothing
   is lost, and ▶️ Resume continues from that hand-off. Messages you sent during the
   turn are already with the session; the hand-off covers them.
• 💾 Close & keep — stop the session + close the topic, keep everything
   (a ♻️ Reopen button appears to resume later with full context)
• 🗑 Close & delete — remove the topic + session (transcript stays on disk)
• 🧹 Close, delete & remove all — wipe everything: topic, session, delivered
   files, and the transcript (no longer resumable)

Typed in a topic: use fable high · use opus · effort max · effort default · feed on · feed off

🖼️ Files both ways:
• Claude can send you images/files — they appear right in the topic.
• Send a photo, video, or file into a topic and the session can read it.
• Send a voice note and it is transcribed (🎙️) and handled like typed text (needs TRANSCRIBE_CMD).

❓ Questions & plans:
• Clarifying questions appear as tappable options (or type your own answer).
• A proposed plan is shown, then you tap ✅ Allow / ❌ Deny.
• Risky tools (Bash/Write/Edit/Web) ask ✅ Allow / ❌ Deny — unless ⚡ auto is on.`
}
