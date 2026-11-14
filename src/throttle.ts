/**
 * At most `limit` events per key per window: a refusal said once a minute per topic and
 * kind, a member answered ten times a minute, so a member's flood of refused or trivial
 * messages is not the bot's flood (and, under Telegram's 429 retries on the bot's
 * replies, not a stall of every topic). Pure, so the flood is tested without a bot.
 */
export class Throttle {
  private readonly windows = new Map<string, { start: number; n: number }>()
  private lastSweep = -Infinity

  constructor(
    private readonly windowMs: number,
    private readonly now: () => number = () => Date.now(),
    private readonly limit = 1,
  ) {}

  /** Whether a firing of this key would be allowed now; nothing is recorded. */
  peek(key: string): boolean {
    const w = this.windows.get(key)
    return !w || this.now() - w.start >= this.windowMs || w.n < this.limit
  }

  /** True while this key has fired fewer than `limit` times in its current window; records the firing. */
  allow(key: string): boolean {
    const t = this.now()
    const w = this.windows.get(key)
    if (w && t - w.start < this.windowMs) {
      if (w.n >= this.limit) return false
      w.n++
      return true
    }
    this.windows.set(key, { start: t, n: 1 })
    // Keys come and go (topics, senders): once the map is large, entries past their window go,
    // at most once a window, so a large map is not walked on every call.
    if (this.windows.size > 1000 && t - this.lastSweep >= this.windowMs) {
      this.lastSweep = t
      for (const [k, x] of this.windows) if (t - x.start >= this.windowMs) this.windows.delete(k)
    }
    return true
  }

  /** Keys held, expired ones included until the next sweep. */
  get size(): number {
    return this.windows.size
  }
}
