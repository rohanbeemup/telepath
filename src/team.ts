/**
 * Team mode's typed grammar: what a member may say to open a topic. Pure, so the
 * refusal of `cwd=` and `auto` is tested without a bot.
 */

export type Member = { firstName?: string; username?: string }

/**
 * `/new <title…>`: the whole line is the title, whitespace collapsed; nothing in it
 * configures the session (the profile does). An empty line names the topic after the
 * member and the time, so a list of topics still reads.
 */
export function parseTeamNew(args: string, member: Member, now: Date): { title: string } {
  const title = args.trim().replace(/\s+/g, ' ')
  if (title) return { title }
  const who = member.firstName?.trim() || member.username?.trim() || 'member'
  const hh = String(now.getHours()).padStart(2, '0')
  const mm = String(now.getMinutes()).padStart(2, '0')
  return { title: `${who} · ${hh}:${mm}` }
}

/** How many topics one member may open per calendar day (UTC); in memory, so a restart starts the day over. */
export class TopicQuota {
  private readonly counts = new Map<string, { day: string; n: number }>()

  constructor(
    private readonly limit: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Count one opening for this member; false when the day's allowance is used up. */
  take(userId: string): boolean {
    const day = new Date(this.now()).toISOString().slice(0, 10)
    const c = this.counts.get(userId)
    const n = c && c.day === day ? c.n : 0
    if (n >= this.limit) return false
    this.counts.set(userId, { day, n: n + 1 })
    return true
  }
}
