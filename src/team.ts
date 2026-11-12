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
