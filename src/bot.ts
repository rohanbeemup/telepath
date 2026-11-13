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
import { admitted, allowedAction, membershipRequired, profileFreshOnly, profileLocked, promptTapAllowed, Membership, type AccessConfig } from './access'
import { Throttle } from './throttle'
import { KNOWN_COMMANDS, parseTyped, type Typed } from './commands'
import type { Profile } from './profile'
import { parseTeamNew, TITLE_MAX, TopicQuota, type Member } from './team'
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
import { transcribe, TopicOrder, voiceTurn, NO_TRANSCRIBER, type Heard } from './voice'
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
const TEXT_ONLY = '📎 This assistant reads text only: type your question.'
/** Transcriptions at once: one sender's run of audio is otherwise that many transcriber processes and files. */
const MAX_TRANSCRIBING = 2
/** One text for every place a topic creation can fail; Telegram's own error goes to the log. */
const TOPIC_CREATE_FAILED = "Couldn't create the topic. Is the bot an admin of this group with Manage Topics?"
const PROFILE_OWNS = '🔒 This install runs a profile: the model, effort and approvals are set there.'
const PROFILE_FRESH = '🔒 Not under a profile: every topic starts fresh.'
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

  /** A Bot API error, read one way everywhere: its code, its text, and a 429's retry_after. */
  private describeError(e: unknown): { code?: number; text: string; retryAfter?: number } {
    const any = e as { error_code?: number; description?: string; parameters?: { retry_after?: number }; message?: string }
    return { code: any?.error_code, text: String(any?.description ?? any?.message ?? e), retryAfter: any?.parameters?.retry_after }
  }

  /** What a failed edit means: one that changes nothing is a success, and a message the user deleted is gone. */
  private editOutcome(e: unknown): 'not_modified' | 'gone' | 'other' {
    const d = this.describeError(e)
    if (/not modified/i.test(d.text)) return 'not_modified'
    if (d.code === 400 && /message (to edit )?not found|can't be edited|MESSAGE_ID_INVALID/i.test(d.text)) return 'gone'
    return 'other'
  }

  /**
   * The status message's transport over the Bot API, with Telegram's answers mapped to
   * what TurnStatus needs: a 429 carries `retry_after` (honoured exactly), "message is
   * not modified" is a success, and a message the user deleted is `gone`.
   */
  private statusTransport(): StatusTransport {
    const chat = this.d.cfg.forumChatId
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
          const outcome = this.editOutcome(e)
          if (outcome === 'not_modified') return { ok: true }
          if (outcome === 'gone') return { ok: false, gone: true }
          const d = this.describeError(e)
          if (d.code === 429) {
            this.d.metrics.inc('status_edit_429')
            this.d.log.warn('status.edit_rate_limited', { topic: topicId, retryAfter: d.retryAfter })
            return { ok: false, retryAfterMs: (d.retryAfter ?? 5) * 1000 }
          }
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

  /**
   * Repaint the tapped menu message in place when possible, else send fresh. "Tapped" is
   * checked against the message's own keyboard, which Telegram sets and a client cannot
   * forge: callback data sent against another message (the pinned panel, a colleague's
   * notice) paints nothing over it (security read).
   */
  private async paint(topicId: string | undefined, text: string, kb?: InlineKeyboard): Promise<void> {
    const q = this.menuCtx?.callbackQuery
    const m = q?.message
    // An inaccessible message (too old for Telegram to hand over) has no keyboard to check: not
    // forged, just unknowable, so the result goes out fresh.
    const keyboard = m && 'reply_markup' in m ? m.reply_markup?.inline_keyboard : undefined
    const tapped = !!keyboard?.some(row => row.some(btn => 'callback_data' in btn && btn.callback_data === q?.data))
    if (tapped) {
      try {
        await this.menuCtx!.editMessageText(text, { reply_markup: kb })
        return
      } catch {}
    } else if (q && this.d.cfg.teamMode) {
      // Not the tapped message's own button: forged, a stale client whose message was already
      // repainted, or a message with no keyboard to check. The outcome still goes out, since the
      // action it reports (a topic created, an allowance spent) has happened, but as a fresh
      // message on the reply rule, so a crafted tap is bounded and a real one is answered
      // (twentieth and twenty-first reviews, sixth security read).
      if (keyboard) this.d.metrics.inc('forged_taps')
      if (this.muted(topicId, 'paint', String(q.from.id))) return
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
        if (this.d.profile) {
          // Nothing to switch under a profile; a spent budget is said now, not at the next message.
          // The CLI's error strings can name host paths: logged for the operator, not posted.
          if (ev.errors.length) this.d.log.warn('turn.error_detail', { topic: topicId, subtype: ev.subtype, errors: ev.errors })
          const budget = ev.subtype === 'error_max_budget_usd' ? '\n💸 This topic has used its budget. Open a new topic for the next question.' : ''
          // A broken model (a revoked key) would otherwise answer every member message with a notice.
          if (!budget && !this.replyAllowed(topicId, 'error')) return
          await this.send(topicId, `⚠️ turn ended: ${ev.subtype}.${budget}`)
          return
        }
        const detail = ev.errors.length ? `\n${ev.errors.map(e => e.slice(0, 300)).join('\n')}` : ''
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
        if (this.d.profile) {
          if (this.muted(topicId, 'error')) return
          await this.send(topicId, `⚠️ model error: ${ev.error}.`)
        } else await this.send(topicId, `⚠️ model error: ${ev.error}. Tap ⚙️ to switch model or adjust this session.`, controlsKb())
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

  /** Media in General: outside team mode a hint; in team mode nothing, General being the members' own (commands only). */
  private async generalOnly(hint: string): Promise<void> {
    if (!this.d.cfg.teamMode) await this.say(undefined, hint)
  }

  /** Transcriptions running now; at most MAX_TRANSCRIBING, so one sender's run of audio is not that many transcriber processes. */
  private transcribing = 0
  /**
   * Topics with a voice note queued or being heard, marked when the note is queued: in team
   * mode a second note waits for the first (not for anything else queued there), and a burst
   * cannot pile up behind a busy queue (eighteenth review, Codex hook).
   */
  private readonly pendingVoice = new Set<string>()

  /**
   * A voice note becomes the words in it, then goes the way typed text does. Any failure is
   * said in the topic (under a profile without its detail, which can name host paths; the
   * log has it). Nothing is downloaded that cannot be heard, and the audio is removed once
   * it has been: nothing reads it afterwards.
   */
  private async handleVoice(ctx: Context, topicId: string, media: { file_id: string; file_unique_id: string; file_size?: number; file_name?: string }, shared: Omit<Heard, 'words'>): Promise<void> {
    try {
      if (media.file_size && media.file_size > MAX_DOWNLOAD_BYTES) {
        return await this.notice(topicId, 'voice', `🎙️ Voice note too large (${(media.file_size / 1048576).toFixed(1)} MB): Telegram caps bot downloads at 20 MB.`, this.senderId(ctx))
      }
      if (!this.d.cfg.transcribeCmd) {
        return await this.notice(topicId, 'voice', this.d.profile ? '🎙️ Voice notes are not transcribed on this install: type your question.' : `🎙️ Voice note not transcribed: ${NO_TRANSCRIBER}`, this.senderId(ctx))
      }
      if (this.transcribing >= MAX_TRANSCRIBING) return await this.notice(topicId, 'voice', `🎙️ ${MAX_TRANSCRIBING} voice notes are being transcribed already. Send it again in a moment.`, this.senderId(ctx))
      // Reserved before any await, so notes arriving in other topics meanwhile cannot all pass
      // the check; the download counts too, which bounds the disk as well as the processes.
      this.transcribing++
      let words: string
      try {
        // In team mode a fresh topic binds (and pays its opening) before any download and after the
        // refusals that cost nothing: a refused opening costs no transcription, and a refused note
        // costs no opening. The member's own note then goes the way typed text does, once heard,
        // into a topic already bound.
        if (this.d.cfg.teamMode && !this.d.store.registry[topicId] && !(await this.bindFreshProfileTopic(ctx, topicId))) return
        if (topicId) await this.typing(topicId)
        const path = this.d.files.saveInbox(media.file_name || `${media.file_unique_id}.ogg`, await this.download(media.file_id))
        try {
          words = await transcribe(path, this.d.cfg.transcribeCmd)
        } finally {
          this.d.files.removeInbox(path)
        }
      } finally {
        this.transcribing--
      }
      this.d.metrics.inc('voice_notes')
      const turn = voiceTurn({ words, ...shared })
      if (!shared.forwarded && !shared.audioFile) {
        // the user's own voice note: their turn, as if typed (commands included)
        await this.say(topicId, `🎙️ ${words}`)
        return await this.handleText(ctx, turn)
      }
      // A topic that refuses (closed, spent, full) is told so by sendToTopic; "passed on" is said
      // only when the words can reach the session (twentieth review).
      if (this.topics.openRefusal(topicId)) return void (await this.topics.sendToTopic(topicId, turn, { senderId: this.senderId(ctx) }))
      await this.say(topicId, `🎙️ ${shared.audioFile ? 'Audio file' : 'Forwarded voice note'}, passed on as content: ${words}`)
      if (!(await this.topics.sendToTopic(topicId, turn, { senderId: this.senderId(ctx) }))) await this.say(topicId, this.noSessionHint())
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e)
      if (!this.d.profile) return await this.notice(topicId, 'voice', `🎙️ Voice note not transcribed: ${reason}`, this.senderId(ctx))
      this.d.log.warn('voice.failed', { topic: topicId, error: reason })
      await this.notice(topicId, 'voice', '🎙️ Voice note not transcribed; the operator has the detail. Type your question instead.', this.senderId(ctx))
    }
  }

  /** Download an inbound video / GIF / video note upload and tell the session where it landed.
   *  Voice and audio go through handleVoice (transcription) instead. */
  private async handleIncomingMedia(ctx: Context, kind: InboundKind): Promise<void> {
    const topicId = this.topicIdOf(ctx)
    if (!topicId) return void this.generalOnly('Send media inside a session topic.')
    if (await this.mediaRefusedUnderProfile(topicId, this.senderId(ctx))) return
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

  /** One guard for every inbound media kind: a profile session has no file tool, and the host path stays out of the chat. */
  private async mediaRefusedUnderProfile(topicId: string, senderId?: string): Promise<boolean> {
    if (!this.d.profile) return false
    await this.notice(topicId, 'media', this.d.cfg.transcribeCmd ? `${TEXT_ONLY} Voice notes are transcribed.` : TEXT_ONLY, senderId)
    return true
  }

  private async download(fileId: string): Promise<Uint8Array> {
    const file = await this.bot.api.getFile(fileId)
    const url = `https://api.telegram.org/file/bot${this.d.cfg.telegramToken}/${file.file_path}`
    // a hung download would otherwise hold its topic's queue forever
    return new Uint8Array(await (await fetch(url, { signal: AbortSignal.timeout(120_000) })).arrayBuffer())
  }

  // ── topics: create / bind / controls ─────────────────────────────────────

  /**
   * The forum topic an update is in; undefined in General. A reply in General carries a
   * `message_thread_id` too (its reply chain), and `is_topic_message` is what tells a topic
   * from one: without it a reply in General would bind and pay for a topic that is not there.
   */
  private topicIdOf(ctx: Context): string | undefined {
    const m = ctx.message ?? ctx.callbackQuery?.message
    return m?.is_topic_message && m.message_thread_id ? String(m.message_thread_id) : undefined
  }

  private senderId(ctx: Context): string | undefined {
    return ctx.from ? String(ctx.from.id) : undefined
  }

  /** The new topic's id, or undefined after a failure, whose Telegram error is in the log; the caller says TOPIC_CREATE_FAILED its own way. */
  private async createTopic(name: string): Promise<string | undefined> {
    try {
      const topic = await this.bot.api.createForumTopic(this.d.cfg.forumChatId, name.slice(0, TITLE_MAX) || 'session')
      return String(topic.message_thread_id)
    } catch (e) {
      this.d.log.error('topic.create_failed', { error: e })
      return undefined
    }
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
      const panel = this.panel(b)
      const sent = await this.bot.api.sendMessage(this.d.cfg.forumChatId, panel.text, {
        message_thread_id: Number(topicId),
        reply_markup: panel.kb,
      })
      b.controlMsgId = sent.message_id
      this.d.store.saveRegistry()
      // For one user, pinned non-silently: the event is what makes mobile Telegram show the
      // per-topic pin bar. In a shared forum, silently: a member's twenty topics a day would
      // otherwise be twenty pushes to every member (twenty-first review).
      await this.bot.api.pinChatMessage(this.d.cfg.forumChatId, sent.message_id, { disable_notification: this.d.cfg.teamMode }).catch(e => this.d.log.warn('pin.failed', { topic: topicId, error: e }))
    } catch (e) {
      this.d.log.error('controls.post_failed', { topic: topicId, error: e })
    }
  }

  /** The wrap-up confirmation, with the queue count from the live session. */
  private async offerWrapUp(topicId: string, senderId?: string): Promise<void> {
    const live = this.topics.live.get(topicId)
    if (!live || !isBusy(live)) return this.notice(topicId, 'wrap', 'Nothing is running in this topic right now, so there is nothing to wrap up.', senderId)
    // The confirmation too: a member tapping "Wrap up" thirty times is thirty posts otherwise.
    if (this.muted(topicId, 'wrap', senderId)) return
    await this.send(topicId, wrapConfirmText(live.queued), wrapConfirmKb())
  }

  private async repaintControls(topicId: string, b: Binding, note?: string): Promise<void> {
    const panel = this.panel(b, note)
    await this.paint(topicId, panel.text, panel.kb)
  }

  /** The topic's control panel, text and keyboard, from one place. */
  private panel(b: Binding, note?: string): { text: string; kb: InlineKeyboard } {
    return { text: topicControlsText(this.d.cfg.catalog, b, note, this.kbMode()), kb: topicControlsKb(this.d.cfg.catalog, b, this.kbMode()) }
  }

  /** An unpinned copy of the panel, where the pinned one could not be edited or shows nothing new. */
  private sendPanel(topicId: string, b: Binding): Promise<void> {
    const panel = this.panel(b)
    return this.send(topicId, panel.text, panel.kb)
  }

  /**
   * ⚙️ from a notice: refresh the pinned panel itself, never the notice the button sat
   * on, and re-post only a panel that is gone (a re-post re-pins, and a pin notifies the
   * whole forum, so a 429 or a network error on the edit is logged and left).
   */
  private async refreshPinnedControls(topicId: string, b: Binding): Promise<'edited' | 'unchanged' | 'posted'> {
    if (b.controlMsgId) {
      try {
        const panel = this.panel(b)
        await this.bot.api.editMessageText(this.d.cfg.forumChatId, b.controlMsgId, panel.text, { reply_markup: panel.kb })
        return 'edited'
      } catch (e) {
        const outcome = this.editOutcome(e)
        if (outcome === 'not_modified') return 'unchanged'
        if (outcome !== 'gone') {
          // A 429 or a network error: the pinned panel keeps its old state, so the current one
          // (a closed topic's Reopen, say) goes out as an unpinned copy; no re-pin, no notification.
          this.d.log.warn('controls.refresh_failed', { topic: topicId, error: this.describeError(e).text })
          await this.sendPanel(topicId, b)
          return 'posted'
        }
        // Deleted by hand: posting again is the only way to have a panel at all.
      }
    }
    await this.postPinnedControls(topicId)
    return 'posted'
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

  /** The topic's own name, carried by messages that reply to its creation: a member's text, or the bot's message a tap sits on. */
  private topicTitleOf(ctx: Context): string | undefined {
    const m = ctx.message ?? ctx.callbackQuery?.message
    return m?.reply_to_message?.forum_topic_created?.name
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
    await this.notice(where, 'quota', `🧮 You have opened ${this.d.cfg.teamTopicsPerDay} topics today, the daily allowance. Keep asking in one of them, or come back tomorrow.`, uid)
    return false
  }

  private refundTopic(ctx: Context): void {
    const uid = this.senderId(ctx)
    if (uid && membershipRequired(this.access, uid)) this.quota.refund(uid)
  }

  /**
   * A fresh topic a member typed or spoke into: bound to the profile, within the allowance.
   * Every caller reads the registry just before, under the topic's own ordering (one update
   * at a time, handlers queued per topic), so the topic is still unbound here.
   */
  /**
   * A member's own creation allowance, ten a minute, asked after the day's (which is cheaper
   * and refuses first) and given back with it when the creation fails: a refused creation is
   * refunded from the day, so the day alone does not bound the attempts (fourth security read);
   * a topic made by hand in Telegram costs the same pin and counts the same (sixth). Admins
   * are exempt, as from the day's.
   */
  private async reserveCreation(ctx: Context, where: string | undefined): Promise<boolean> {
    const sender = this.senderId(ctx)
    if (!this.d.cfg.teamMode || !sender || !membershipRequired(this.access, sender)) return true
    if (this.creations.allow(sender)) return true
    this.refundTopic(ctx)
    await this.notice(where, 'create', '⏳ Too many new topics in a minute. Try again shortly.', sender)
    return false
  }

  private async bindFreshProfileTopic(ctx: Context, topicId: string): Promise<boolean> {
    if (this.removed.has(topicId)) return false // deleted by an admin while this message waited: gone, or going
    if (!(await this.reserveTopic(ctx, topicId))) return false
    if (!(await this.reserveCreation(ctx, topicId))) return false
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
    this.bind(topicId, { cwd: p?.cwd ?? this.d.store.defaultCwd(), model: p?.model ?? prefs.defaultModel, effort: p?.effort ?? prefs.defaultEffort, title, auto: false, profile: true })
    this.d.metrics.inc('topics_created')
  }

  /** ⚙️ and /menu: the pinned panel of a bound topic, refreshed in place, or the main menu. */
  private async controlsOrMenu(topicId: string | undefined, fresh = false): Promise<'menu' | 'edited' | 'unchanged' | 'posted'> {
    const b = topicId ? this.d.store.registry[topicId] : undefined
    if (!topicId || !b) {
      await this.showMainMenu(topicId, fresh)
      return 'menu'
    }
    // In a shared forum the panel is refreshed where it is (a re-post re-pins, and a pin notifies
    // the whole forum); for one user it is brought to the bottom, as before.
    if (!this.d.cfg.teamMode) {
      await this.postPinnedControls(topicId)
      return 'posted'
    }
    const shown = await this.refreshPinnedControls(topicId, b)
    // A typed /menu whose panel was already current would otherwise show nothing: an unpinned copy.
    if (shown === 'unchanged' && fresh) await this.sendPanel(topicId, b)
    return shown
  }

  /**
   * /new, 🆕 and ⚡ with a profile: one path, within the allowance. A tap's outcome paints
   * the tapped menu; typed or spoken text gets a fresh message, because the voice path
   * runs outside the update loop and the shared menu context may be another member's.
   */
  private async createProfileTopic(ctx: Context, title: string, intoTopic: string | undefined, via: 'tap' | 'text'): Promise<void> {
    const tell = (text: string, kb?: InlineKeyboard): Promise<void> => (via === 'tap' ? this.paint(intoTopic, text, kb) : this.send(intoTopic, text, kb))
    // A creation Telegram refuses is refunded, so the daily allowance does not bound the attempts
    // while creation fails: a member's own creation allowance does (fourth security read), apart
    // from the reply allowance so that ten replies do not cost a topic; admins are exempt, as from
    // the daily allowance.
    if (!(await this.reserveTopic(ctx, intoTopic))) return
    if (!(await this.reserveCreation(ctx, intoTopic))) return
    const topicId = await this.createTopic(title)
    if (!topicId) {
      this.refundTopic(ctx) // only an opening that happened counts
      return tell(TOPIC_CREATE_FAILED, backKb())
    }
    this.bindProfileTopic(topicId, title)
    await this.postPinnedControls(topicId)
    await tell(`✅ Created "${title}".`, openLinkKb(this.d.cfg.forumChatId, topicId))
  }

  private async newSession(name: string, cwd: string, model: string, effort: Effort | undefined, auto: boolean, intoTopic?: string): Promise<string | undefined> {
    const topicId = await this.createTopic(name)
    if (!topicId) {
      await this.paint(intoTopic, TOPIC_CREATE_FAILED, backKb())
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
    const topicId = await this.createTopic(title)
    if (!topicId) {
      await this.say(fromTopic, TOPIC_CREATE_FAILED)
      return
    }
    this.bind(topicId, { sessionId: match.sessionId, cwd: match.cwd || this.d.cfg.defaultCwd, model: this.d.store.prefs.defaultModel, effort: this.d.store.prefs.defaultEffort, title })
    await this.postPinnedControls(topicId)
    return topicId
  }

  // ── screens ──────────────────────────────────────────────────────────────

  /**
   * The main menu: painted over the tapped menu message, or, for a typed command, sent
   * fresh. The tapped message is whoever's tapped last, which in a shared forum is another
   * member's screen (fourteenth review).
   */
  private async showMainMenu(topicId: string | undefined, fresh = false): Promise<void> {
    const text = '👋 What would you like to do?'
    if (fresh) await this.send(topicId, text, mainMenuKb(this.kbMode()))
    else await this.paint(topicId, text, mainMenuKb(this.kbMode()))
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
      topicId = await this.createTopic(name)
      if (!topicId) {
        await this.send(undefined, TOPIC_CREATE_FAILED)
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

    if (data === 'm:menu') {
      await ack()
      if (this.muted(topicId, 'menu', this.senderId(ctx))) return
      return this.showMainMenu(topicId)
    }
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
    if (data === 'm:help') {
      await ack()
      if (this.muted(topicId, 'help', this.senderId(ctx))) return
      return void this.send(topicId, this.d.cfg.teamMode ? teamHelp() : help(this.d.cfg.reposDir), backKb())
    }
    if (data === 'm:cancel') {
      this.wizard.delete(uid)
      await ack('Cancelled')
      if (this.muted(topicId, 'menu', this.senderId(ctx))) return
      return this.showMainMenu(topicId)
    }
    if (data === 'm:ctl') {
      if (this.muted(topicId, 'menu', this.senderId(ctx))) return void ack()
      const shown = await this.controlsOrMenu(topicId)
      // A panel already current edits to nothing: say where it is, or the tap looks dead.
      return void ack(shown === 'unchanged' ? '⚙️ The controls are pinned at the top of this topic' : undefined)
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
      return this.offerWrapUp(topicId, this.senderId(ctx))
    }
    const tw = /^m:tw:(now|turn)$/.exec(data)
    if (tw) {
      const ok = this.topics.wrapUp(topicId, { when: tw[1] === 'turn' ? 'after-turn' : 'now' })
      await ack(ok ? '⏹ Wrapping up…' : 'Nothing is running')
      if (!ok) return this.notice(topicId, 'wrap', 'Nothing is running in this topic right now, so there is nothing to wrap up.', this.senderId(ctx))
      return this.paint(topicId, tw[1] === 'turn' ? '⏳ Wrapping up after this turn: the session finishes what it is doing, then writes a hand-off.' : '⏹ Wrapping up: the session finishes its current step, then writes a hand-off.')
    }
    if (data === 'm:tres') {
      const hb = this.d.store.registry[topicId]
      // A binding from before the profile was adopted at boot, so no hand-off here is the operator's.
      const h = hb?.handoff ? parseHandoff(hb.handoff.text) : undefined
      if (!h) return void ack('No hand-off saved for this topic')
      await ack('▶️ Resuming')
      this.status.bump(topicId)
      await this.typing(topicId)
      await this.topics.sendToTopic(topicId, resumePrompt(h), { senderId: this.senderId(ctx) })
      return
    }
    if (data === 'm:tf') {
      if (!b) return void ack('No session here')
      // Every flip writes the registry and edits the panel: in a shared forum, so many a minute.
      if (this.muted(topicId, 'feed', this.senderId(ctx))) return void ack('Try again in a moment')
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
      if (b && this.d.cfg.teamMode) {
        // Closed for everyone until an admin reopens it: the flag first, before anything yields,
        // so a queued note or line cannot open a fresh session in the gap (eighteenth review).
        b.closed = true
        store.saveRegistry()
      }
      this.topics.userTookOver(topicId)
      this.topics.closeLive(topicId, 'closed & kept by user')
      void this.status.drop(topicId)
      await ack('💾 Closed')
      if (b && this.d.cfg.teamMode) {
        // The pinned panel shows the closed state with ♻️ Reopen and stays pinned, so "reopen it
        // from the pinned panel" is true, and a later refresh keeps the button (seventeenth review).
        await this.refreshPinnedControls(topicId, b)
      } else {
        // One user's kept topic resumes on its next message; no flag is written.
        if (b?.controlMsgId) await this.bot.api.unpinChatMessage(this.d.cfg.forumChatId, b.controlMsgId).catch(() => {})
        await this.paint(topicId, '💾 Session closed and saved — your context is kept. Reopen to resume.', new InlineKeyboard().text('♻️ Reopen & resume', 'm:treopen'))
      }
      await this.bot.api.closeForumTopic(this.d.cfg.forumChatId, Number(topicId)).catch(e => this.d.log.warn('topic.close_failed', { topic: topicId, error: e }))
      return
    }
    if (data === 'm:treopen') {
      await this.bot.api.reopenForumTopic(this.d.cfg.forumChatId, Number(topicId)).catch(e => this.d.log.warn('topic.reopen_failed', { topic: topicId, error: e }))
      if (!b) return void this.paint(topicId, 'That session no longer exists.', backKb())
      b.closed = false
      store.saveRegistry()
      if (this.d.cfg.teamMode) {
        // Reopened, not resumed: like a fresh topic, it costs no process until someone writes in
        // it. The panel stayed pinned through the close, so it is refreshed, never re-pinned.
        await ack('♻️ Reopened')
        await this.refreshPinnedControls(topicId, b)
        return
      }
      const live = this.topics.ensureLive(topicId)
      const why = live ? undefined : this.topics.openRefusal(topicId)
      await ack(live ? '♻️ Reopened' : `♻️ Reopened, but no session could open${why ? ` (${why})` : ''}`)
      await this.repaintControls(topicId, b)
      if (b.controlMsgId) await this.bot.api.pinChatMessage(this.d.cfg.forumChatId, b.controlMsgId).catch(() => {})
      return
    }
    if (data === 'm:tdelete') {
      await ack()
      return this.paint(
        topicId,
        this.d.profile
          ? '🗑 Delete this topic and forget its session here?\nThe transcript stays on disk. To remove everything, use 🧹 instead.'
          : '🗑 Delete this topic and forget its session here?\nThe transcript stays on disk and can be reopened later from 📋 My sessions or /attach. To remove everything, use 🧹 instead.',
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

  /** Topics deleted this process: a note still being heard there must not bind it again while Telegram removes it. */
  private readonly removed = new Set<string>()

  private removeTopic(topicId: string, wipe: boolean): void {
    this.removed.add(topicId)
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
      return this.notice(topicId, 'admins', '🔒 Admins only.', fromId)
    }

    if (typed.kind === 'slash') {
      // An unknown command (/start, a typo) is nobody's to refuse: the menu, or silence in a team's General.
      if (!KNOWN_COMMANDS.has(typed.cmd)) {
        if (!topicId && this.d.cfg.teamMode) return
        // In a shared forum a menu per unknown command is a flood a member can cause: once a minute per topic.
        if (this.muted(topicId, 'menu', fromId)) return
        return this.showMainMenu(topicId, true)
      }
      if (!allowedAction(this.access, fromId, `/${typed.cmd}`)) return refuse()
      if (this.d.profile && profileLocked(`/${typed.cmd}`)) return void this.say(topicId, PROFILE_OWNS)
      if (this.d.profile && profileFreshOnly(`/${typed.cmd}`)) return void this.say(topicId, PROFILE_FRESH)
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
          // A typed menu or help text is a reply a member can trigger at will: in a shared forum, so many a minute.
          if (this.muted(topicId, 'menu', fromId)) return
          await this.controlsOrMenu(topicId, true)
          return
        case 'help':
          if (this.muted(topicId, 'help', fromId)) return
          return void this.say(topicId, this.d.cfg.teamMode ? teamHelp() : help(this.d.cfg.reposDir))
        default:
          return // every known command has a case above; KNOWN_COMMANDS gated the rest before the switch
      }
    }

    if (!topicId) {
      if (this.d.cfg.teamMode) return // General is the members' own; the bot answers commands there, not chatter
      return this.showMainMenu(undefined, true) // plain text in General → the menu
    }

    // A pending clarifying question takes any typed reply as its free-text answer, before
    // the admin gate: the answer is the session's, whatever words it happens to be.
    const ft = this.askFreeText.get(topicId)
    if (ft) return void ft(raw)

    if (!allowedAction(this.access, fromId, typed.kind)) return refuse()

    let b = this.d.store.registry[topicId]
    if (!b && this.d.cfg.teamMode) {
      // A fresh topic a member typed into is bound first, whatever the line says, so `feed on`
      // or `wrap` as a first line meets the topic any other first line would have created.
      if (!(await this.bindFreshProfileTopic(ctx, topicId))) return
      b = this.d.store.registry[topicId]
    }
    if (typed.kind === 'wrap') return this.offerWrapUp(topicId, fromId)
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
      if (this.muted(topicId, 'feed', fromId)) return
      b.feed = typed.on
      this.d.store.saveRegistry()
      return void this.say(topicId, typed.on ? '🔎 Activity feed ON — one line per tool call.' : '🔎 Activity feed OFF.')
    }

    if (!b) return void this.send(topicId, 'This topic has no Claude session yet.', new InlineKeyboard().text('🆕 Start a session here', 'm:newhere'))
    this.status.bump(topicId) // the user's own message now sits below the status
    await this.typing(topicId)
    if (!(await this.topics.sendToTopic(topicId, typed.text, { senderId: fromId }))) await this.say(topicId, this.noSessionHint())
  }

  /** Under a profile every topic starts fresh, so /attach is not on offer. */
  private noSessionHint(): string {
    return this.d.profile ? 'No session bound to this topic. Use /new first.' : 'No session bound to this topic. Use /new (or /attach) first.'
  }

  // ── wiring ───────────────────────────────────────────────────────────────

  private allowed(ctx: Context): boolean {
    return admitted(this.access, { fromId: this.senderId(ctx), chatId: ctx.chat ? String(ctx.chat.id) : undefined, anonymous: !!ctx.message?.sender_chat })
  }

  /** Topics where a post made as the group has been answered with the reason once. */
  private readonly anonymousNoticed = new Set<string>()

  /** A reply of one kind at most once a minute per topic (General counted as one). */
  private readonly refusals = new Throttle(60_000)
  /** And at most ten replies a minute to one member, whatever the topics: the key space of topics is theirs to grow. */
  private readonly senderReplies = new Throttle(60_000, () => Date.now(), 10)
  /** A member's topic creations, ten a minute: a creation Telegram refuses is refunded, so the day's allowance alone does not bound the attempts. */
  private readonly creations = new Throttle(60_000, () => Date.now(), 10)

  /** Whether a reply a member can trigger at will is muted now; counted when it is. */
  private muted(topicId: string | undefined, kind: string, senderId?: string): boolean {
    if (this.replyAllowed(topicId, kind, senderId)) return false
    this.d.metrics.inc('refusals_muted')
    return true
  }

  /**
   * Whether a reply a member can trigger at will (a refusal, the help text, a menu) goes
   * out now. Every refused message is counted; a member's flood of them is not the bot's
   * flood (security read), which under Telegram's 429 retries on the bot's replies would
   * stall the update loop for everyone.
   */
  replyAllowed(topicId: string | undefined, kind: string, senderId?: string): boolean {
    if (!this.d.cfg.teamMode) return true // the throttles are a shared forum's: one user's notices are all answered
    // An admin is configured, not throttled, as with the daily allowance: a member's slot must
    // not mute the admin's own action a moment later (twenty-first review).
    if (senderId !== undefined && !membershipRequired(this.access, senderId)) return true
    // Both asked before either is charged: a member past their allowance must not use up the
    // topic's one slot for that kind and silence a colleague's notice (sixteenth review), and a
    // reply the topic's slot mutes must not cost the member an allowance they will need for the
    // one notice that explains their refusal (twentieth review).
    const key = `${topicId ?? 'general'}:${kind}`
    if (senderId !== undefined && !this.senderReplies.peek(senderId)) return false
    if (!this.refusals.peek(key)) return false
    if (senderId !== undefined) this.senderReplies.allow(senderId)
    this.refusals.allow(key)
    return true
  }

  /** A refusal notice: "Admins only", the quota, the text-only and voice notices. */
  private async notice(topicId: string | undefined, kind: string, text: string, senderId?: string): Promise<void> {
    if (this.muted(topicId, kind, senderId)) return
    await this.say(topicId, text)
  }

  /**
   * A post made as the group (an admin with "Remain anonymous" on) carries no sender to
   * verify, so it gets no answer, while the same admin's taps, which carry their account,
   * work: said once per topic, so the admin learns why their typed lines go unanswered.
   * Not in General, where a linked channel's posts land the same way, and only in the forum.
   */
  private async noticeAnonymous(ctx: Context): Promise<void> {
    const topicId = this.topicIdOf(ctx)
    if (!this.d.cfg.teamMode || !ctx.message?.sender_chat || !topicId || !ctx.chat || String(ctx.chat.id) !== this.access.forumChatId) return
    if (this.anonymousNoticed.has(topicId)) return
    this.anonymousNoticed.add(topicId)
    await this.notice(topicId, 'anon', '🎭 Posts made as the group or as a channel get no answer: Telegram hides who wrote them. Post as yourself to chat here ("Remain anonymous" off, "Send as" yourself).')
  }

  /**
   * The chat gate, then in team mode the forum's own member list for everyone but the
   * configured admins. A lookup that failed is a no, said once per grace so a Telegram
   * blip reads as a blip and not as a dead bot.
   */
  private async admit(ctx: Context): Promise<boolean> {
    if (!this.allowed(ctx)) {
      await this.noticeAnonymous(ctx)
      return false
    }
    const uid = this.senderId(ctx)
    if (!membershipRequired(this.access, uid)) return true
    if (!uid) return false
    const verdict = await this.membership.check(uid)
    if (verdict === 'member') return true
    this.d.metrics.inc(verdict === 'unknown' ? 'membership_unknown' : 'non_member_rejected')
    if (verdict === 'unknown' && this.membership.noticeDue(uid)) await this.notice(this.topicIdOf(ctx), 'verify', '⚠️ Could not verify your membership just now. Try again in a moment.', uid)
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
        if (!topicId) return await this.generalOnly('Send images inside a session topic.')
        if (await this.mediaRefusedUnderProfile(topicId, this.senderId(ctx))) return
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
        if (!topicId) return await this.generalOnly('Send files inside a session topic.')
        if (await this.mediaRefusedUnderProfile(topicId, this.senderId(ctx))) return
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
      if (!topicId) return await this.generalOnly('Send voice notes inside a session topic.')
      this.status.bump(topicId)
      const shared = {
        audioFile: !ctx.message.voice,
        forwarded: originName(ctx.message.forward_origin),
        caption: ctx.message.caption?.trim() || undefined,
      }
      // queued per topic, so whatever is sent after the note is handled after it; in a shared
      // forum one at a time per topic, or a run of notes holds the topic and both slots for hours
      if (this.d.cfg.teamMode && this.pendingVoice.has(topicId)) return await this.notice(topicId, 'voice', '🎙️ A voice note is still being transcribed here. Send the next one when it is done.', this.senderId(ctx))
      this.pendingVoice.add(topicId)
      this.order.queue(topicId, () => this.handleVoice(ctx, topicId, media, shared).finally(() => this.pendingVoice.delete(topicId)),
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
      if (data.startsWith('m:') && this.d.profile && profileFreshOnly(data)) return void ctx.answerCallbackQuery({ text: 'Not under a profile: every topic starts fresh.' }).catch(() => {})
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
