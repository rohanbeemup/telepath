/**
 * Who may talk to the bot, and who may change a topic: pure decisions over the config.
 * Single-user mode admits one Telegram user in one forum. Team mode admits the forum's
 * members, as the forum itself reports them, and keeps the destructive and configuring
 * actions for the admins.
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
 * activity feed, and the screens that change nothing. Not the status screen: it lists
 * the box's recent errors, the admin ids and every topic's title.
 */
const MEMBER_ACTIONS: ReadonlySet<string> = new Set([
  'chat',
  '/new',
  '/help',
  '/menu',
  'feed',
  'wrap',
  'm:menu',
  'm:new',
  'm:newhere',
  'm:help',
  'm:ctl',
  'm:cancel',
  'm:noop',
  'm:tf',
  'm:twrap',
  'm:tw:now',
  'm:tw:turn',
  'm:tres',
])

/**
 * The actions a profile owns: model, effort and approvals, as taps and as /auto. Typed
 * `use …` and `effort …` are not here: under a profile they configure nothing, so the bot
 * hands them to the session as what the user said.
 */
const PROFILE_LOCKED: ReadonlySet<string> = new Set(['m:ta', '/auto'])

/** The chat gate: the forum, and outside team mode the one allowed user. Membership is Membership's. */
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

/** What the forum said, or that it could not be asked. */
export type Verdict = 'member' | 'no' | 'unknown'

/** Only what the forum calls a member; a status this code has never seen is not one. */
export function isMemberStatus(m: ChatMemberLike): boolean {
  if (m.status === 'creator' || m.status === 'administrator' || m.status === 'member') return true
  if (m.status === 'restricted') return m.is_member === true
  return false
}

/**
 * Team mode's second gate: the forum itself says who is a member. A public supergroup can
 * let anyone post without joining, so the chat id alone proves nothing. A yes is kept for
 * the TTL; a no, and a failed lookup, only for a short grace: a member added a moment ago
 * is not locked out for long, and a non-member or an API error costs one call per grace
 * rather than one per message. `forget` drops an entry when the forum reports a change,
 * so a member removed just now is refused on their next message, not at the TTL.
 */
export class Membership {
  private readonly cache = new Map<string, { until: number; verdict: Verdict }>()
  /** One lookup per sender at a time: a burst of messages shares it. */
  private readonly inflight = new Map<string, Promise<Verdict>>()
  private readonly ttlMs: number
  private readonly graceMs: number
  private readonly maxEntries: number
  private readonly now: () => number

  constructor(
    private readonly lookup: (userId: string) => Promise<ChatMemberLike>,
    opts: { ttlMs?: number; graceMs?: number; now?: () => number; maxEntries?: number } = {},
  ) {
    this.ttlMs = opts.ttlMs ?? 10 * 60_000
    this.graceMs = opts.graceMs ?? 30_000
    this.maxEntries = opts.maxEntries ?? 1000
    this.now = opts.now ?? (() => Date.now())
  }

  /** member, no, or unknown (the lookup failed); the bot tells unknown from no. */
  async check(userId: string): Promise<Verdict> {
    const hit = this.cache.get(userId)
    if (hit && this.now() < hit.until) return hit.verdict
    const pending = this.inflight.get(userId)
    if (pending) return pending
    const p = this.ask(userId).finally(() => this.inflight.delete(userId))
    this.inflight.set(userId, p)
    return p
  }

  private async ask(userId: string): Promise<Verdict> {
    let verdict: Verdict
    try {
      verdict = isMemberStatus(await this.lookup(userId)) ? 'member' : 'no'
    } catch {
      verdict = 'unknown'
    }
    // Strangers come and go; once the cache is full, the expired ones leave.
    if (this.cache.size >= this.maxEntries) this.sweep()
    this.cache.set(userId, { until: this.now() + (verdict === 'member' ? this.ttlMs : this.graceMs), verdict })
    return verdict
  }

  private sweep(): void {
    const now = this.now()
    for (const [id, entry] of this.cache) if (now >= entry.until) this.cache.delete(id)
  }

  async isMember(userId: string): Promise<boolean> {
    return (await this.check(userId)) === 'member'
  }

  /** Entries held, expired ones included until the next sweep. */
  get size(): number {
    return this.cache.size
  }

  /** The forum reported a change for this id: the next check asks again. */
  forget(userId: string): void {
    this.cache.delete(userId)
  }
}

/**
 * Whether a profile owns this action. One rule at the two gates (taps and typed text),
 * so an entry point that changes a binding's model, effort or approvals cannot escape by
 * being new: it is either on this list or it is not a model, effort or approval change.
 */
export function profileLocked(action: string): boolean {
  return PROFILE_LOCKED.has(action) || action.startsWith('m:tm:') || action.startsWith('m:te:')
}

/**
 * Whether the forum must be asked about this sender: team mode, and not an admin from the
 * config. An admin is configured, not inferred, so an API blip never locks out the people
 * who could fix it. The same rule exempts admins from the daily topic cap: one rule, so
 * the two gates cannot drift apart.
 */
export function membershipRequired(cfg: AccessConfig, fromId: string | undefined): boolean {
  return cfg.teamMode && !isAdmin(cfg, fromId)
}
