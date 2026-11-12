/**
 * Who may talk to the bot, and who may change a topic: pure decisions over the config.
 * Single-user mode admits one Telegram user in one forum. Team mode admits every member
 * of that forum (Telegram delivers a group's messages from its members only) and keeps
 * the destructive and configuring actions for the admins.
 */

export type AccessConfig = {
  teamMode: boolean
  allowedUserId: string
  forumChatId: string
  adminUserIds: string[]
}

/** The sender of an update: Telegram's numeric ids as strings; undefined when absent. */
export type Sender = { fromId: string | undefined; chatId: string | undefined }

/**
 * What a member may do in team mode. An allowlist, not a denylist: an action this file
 * has never heard of is an admin's until someone decides otherwise. Everything in it is
 * reversible and local to a topic: chatting, opening a topic, wrapping up a turn, the
 * activity feed, and the screens that change nothing.
 */
const MEMBER_ACTIONS: ReadonlySet<string> = new Set([
  'chat',
  '/new',
  '/help',
  '/menu',
  '/status',
  'feed',
  'wrap',
  'm:menu',
  'm:new',
  'm:newhere',
  'm:help',
  'm:status',
  'm:ctl',
  'm:cancel',
  'm:noop',
  'm:tf',
  'm:twrap',
  'm:tw:now',
  'm:tw:turn',
  'm:tres',
  'm:treopen',
])

export function admitted(cfg: AccessConfig, s: Sender): boolean {
  if (!s.chatId || s.chatId !== cfg.forumChatId) return false
  return cfg.teamMode || (!!s.fromId && s.fromId === cfg.allowedUserId)
}

export function isAdmin(cfg: AccessConfig, fromId: string | undefined): boolean {
  return fromId !== undefined && cfg.adminUserIds.includes(fromId)
}

/**
 * An action is a menu tap's callback data (`m:…`), a slash command (`/new`), or a typed
 * command kind (`use`, `effort`, `feed`, `wrap`, `chat`). Outside team mode the one
 * admitted user may do everything, as before.
 */
export function allowedAction(cfg: AccessConfig, fromId: string | undefined, action: string): boolean {
  if (!cfg.teamMode) return true
  if (isAdmin(cfg, fromId)) return true
  return MEMBER_ACTIONS.has(action)
}

/** What Telegram's getChatMember answers, reduced to what the gate reads. */
export type ChatMemberLike = { status: string; is_member?: boolean }

/** Only what the forum calls a member; a status this code has never seen is not one. */
export function isMemberStatus(m: ChatMemberLike): boolean {
  if (m.status === 'creator' || m.status === 'administrator' || m.status === 'member') return true
  if (m.status === 'restricted') return m.is_member === true
  return false
}

/**
 * Team mode's second gate: the forum itself says who is a member. A public supergroup can
 * let anyone post without joining, so the chat id alone proves nothing. A yes is kept for
 * the TTL; a no only for a short grace, so a member added a moment ago is not locked out
 * for long; a failed lookup is a no that is asked again on the next message.
 */
export class Membership {
  private readonly cache = new Map<string, { until: number; member: boolean }>()
  private readonly ttlMs: number
  private readonly graceMs: number
  private readonly now: () => number

  constructor(
    private readonly lookup: (userId: string) => Promise<ChatMemberLike>,
    opts: { ttlMs?: number; graceMs?: number; now?: () => number } = {},
  ) {
    this.ttlMs = opts.ttlMs ?? 10 * 60_000
    this.graceMs = opts.graceMs ?? 30_000
    this.now = opts.now ?? (() => Date.now())
  }

  async isMember(userId: string): Promise<boolean> {
    const hit = this.cache.get(userId)
    if (hit && this.now() < hit.until) return hit.member
    let member: boolean
    try {
      member = isMemberStatus(await this.lookup(userId))
    } catch {
      this.cache.delete(userId)
      return false
    }
    this.cache.set(userId, { until: this.now() + (member ? this.ttlMs : this.graceMs), member })
    return member
  }
}
