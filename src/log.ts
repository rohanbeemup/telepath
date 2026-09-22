/**
 * Observability primitives: a structured logger (one JSON object per line, so a log can
 * be filtered and counted), process-wide counters, and a bounded ring of recent errors
 * for the /status command. No dependencies, no I/O beyond the injected sink.
 */
import type { LogLevel } from './config'

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

export type Fields = Record<string, unknown>

export type LoggerOptions = {
  level: LogLevel
  sink?: (line: string) => void
  now?: () => Date
  /** Human-readable lines instead of JSON (for a terminal). */
  pretty?: boolean
  ring?: ErrorRing
}

export class Logger {
  private readonly level: number
  private readonly sink: (line: string) => void
  private readonly now: () => Date
  private readonly pretty: boolean
  readonly ring?: ErrorRing

  constructor(opts: LoggerOptions) {
    this.level = ORDER[opts.level]
    this.sink = opts.sink ?? ((l: string) => process.stderr.write(l + '\n'))
    this.now = opts.now ?? (() => new Date())
    this.pretty = opts.pretty ?? false
    this.ring = opts.ring
  }

  debug(ev: string, fields?: Fields): void {
    this.emit('debug', ev, fields)
  }
  info(ev: string, fields?: Fields): void {
    this.emit('info', ev, fields)
  }
  warn(ev: string, fields?: Fields): void {
    this.emit('warn', ev, fields)
  }
  error(ev: string, fields?: Fields): void {
    this.ring?.push({ at: this.now().getTime(), ev, message: String(fields?.error ?? fields?.message ?? ''), fields })
    this.emit('error', ev, fields)
  }

  private emit(lvl: LogLevel, ev: string, fields?: Fields): void {
    if (ORDER[lvl] < this.level) return
    const ts = this.now().toISOString()
    if (this.pretty) {
      const rest = fields ? ' ' + Object.entries(fields).map(([k, v]) => `${k}=${fmt(v)}`).join(' ') : ''
      this.sink(`${ts.slice(11, 19)} ${lvl.padEnd(5)} ${ev}${rest}`)
      return
    }
    this.sink(JSON.stringify({ ts, lvl, ev, ...safeFields(fields) }))
  }
}

function fmt(v: unknown): string {
  if (typeof v === 'string') return /\s/.test(v) ? JSON.stringify(v) : v
  if (v instanceof Error) return v.message
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

/** Errors do not JSON.stringify to anything useful; keep their message. */
function safeFields(fields?: Fields): Fields {
  if (!fields) return {}
  const out: Fields = {}
  for (const [k, v] of Object.entries(fields)) out[k] = v instanceof Error ? `${v.name}: ${v.message}` : v
  return out
}

export class Metrics {
  private readonly counters = new Map<string, number>()
  inc(name: string, by = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + by)
  }
  set(name: string, value: number): void {
    this.counters.set(name, value)
  }
  get(name: string): number {
    return this.counters.get(name) ?? 0
  }
  snapshot(): Record<string, number> {
    return Object.fromEntries([...this.counters.entries()].sort(([a], [b]) => a.localeCompare(b)))
  }
}

export type ErrorEntry = { at: number; ev: string; message: string; fields?: Fields }

export class ErrorRing {
  private readonly items: ErrorEntry[] = []
  constructor(private readonly capacity = 20) {}
  push(e: ErrorEntry): void {
    this.items.push(e)
    if (this.items.length > this.capacity) this.items.splice(0, this.items.length - this.capacity)
  }
  list(): ErrorEntry[] {
    return this.items.slice()
  }
}
