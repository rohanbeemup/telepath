/**
 * At most one event per key per window: a refusal said once a minute per topic, so a
 * member's flood of refused messages is not the bot's flood (and, under Telegram's 429
 * retries on the bot's replies, not a stall of every topic). Pure, so the flood is tested
 * without a bot.
 */
export class Throttle {
  private readonly last = new Map<string, number>()

  constructor(
    private readonly windowMs: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** True when this key has not fired within the window; records the firing. */
  allow(key: string): boolean {
    const t = this.now()
    const prev = this.last.get(key)
    if (prev !== undefined && t - prev < this.windowMs) return false
    this.last.set(key, t)
    // Keys come and go (topics, senders): once the map is large, entries past their window go.
    if (this.last.size > 1000) for (const [k, at] of this.last) if (t - at >= this.windowMs) this.last.delete(k)
    return true
  }

  /** Keys held, expired ones included until the next sweep. */
  get size(): number {
    return this.last.size
  }
}
