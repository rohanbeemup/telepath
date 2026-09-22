#!/usr/bin/env bun
/**
 * Ring 2 for the session layer: one real session through SdkBackend, no Telegram.
 * Spends a few tokens on the logged-in account. Exit 0 = every check passed.
 *
 *   bun scripts/smoke-session.ts [--model claude-haiku-4-5] [--effort low] [--cwd .]
 *
 * Checks: a text turn returns text · the session id is captured after output · a risky
 * tool reaches canUseTool through the PreToolUse gate and a deny is honoured, even on a
 * machine whose settings allow Bash · the primed first prompt's outbox contract reaches
 * the model · resuming by id continues the conversation.
 *
 * One reader consumes the stream for the session's whole life, exactly as the daemon's
 * pump does. Breaking out of `for await` on the stream returns the SDK's generator and
 * ends the session, which is the trap this script's first version fell into.
 */
import { resolve } from 'path'
import { Logger } from '../src/log'
import { SdkBackend } from '../src/session'
import { interpret, newPumpState, type Event } from '../src/interpret'
import { outboxContract, type LiveSession } from '../src/topics'
import { AUTO_ALLOW, preToolUseHookOutput } from '../src/gate'
import { parseEffort } from '../src/models'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const model = arg('model') ?? 'claude-haiku-4-5'
const effort = parseEffort(arg('effort'))
const cwd = resolve(arg('cwd') ?? '.')
const outbox = resolve(cwd, '.smoke-outbox')

const log = new Logger({ level: (arg('log') as any) ?? 'warn', pretty: true })
// Production settings sources, so a permissive ~/.claude/settings.json is part of the test.
const backend = new SdkBackend({ settingSources: ['user', 'project', 'local'], log })

/** Drives one session: a single stream reader, turns awaited by their end event. */
class Driver {
  private waiter: ((t: { text: string; events: Event[] }) => void) | undefined
  private text = ''
  private events: Event[] = []
  readonly st
  constructor(
    private readonly session: LiveSession,
    sessionId: string | undefined,
  ) {
    this.st = newPumpState(sessionId)
    void this.read()
  }
  private async read(): Promise<void> {
    try {
      for await (const msg of this.session.stream()) {
        const evs = interpret(msg, this.st, { feed: true })
        this.events.push(...evs)
        for (const ev of evs) if (ev.kind === 'say') this.text += ev.text
        if (evs.some(e => e.kind === 'turnEnd' || e.kind === 'turnError') && this.waiter) {
          const w = this.waiter
          this.waiter = undefined
          const out = { text: this.text, events: this.events }
          this.text = ''
          this.events = []
          w(out)
        }
      }
    } catch (e) {
      console.error('stream error:', e)
    }
  }
  turn(prompt: string, timeoutMs = 180_000): Promise<{ text: string; events: Event[] }> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`turn timed out after ${timeoutMs} ms`)), timeoutMs)
      this.waiter = r => {
        clearTimeout(timer)
        resolve(r)
      }
      this.session.send(prompt)
    })
  }
}

const results: { name: string; ok: boolean }[] = []
const check = (name: string, ok: boolean, detail: string) => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  —  ${detail}`)
}

let denied = 0
const canUseTool = async (tool: string) => {
  if (AUTO_ALLOW.includes(tool)) return { behavior: 'allow' as const }
  denied++
  return { behavior: 'deny' as const, message: 'smoke test denies every risky tool' }
}
const hooks = { PreToolUse: [{ hooks: [async (input: any) => preToolUseHookOutput(String(input?.tool_name ?? '')) as any] }] }
const env: Record<string, string | undefined> = { ...process.env, TELEPATH_OUTBOX: outbox }
delete env.TELEGRAM_BOT_TOKEN

const t0 = Date.now()
let sessionId: string | undefined
const s1 = backend.open({ topicId: 'smoke', cwd, model, effort, env, canUseTool: canUseTool as any, hooks })
try {
  const d1 = new Driver(s1, undefined)
  // The first prompt carries the outbox contract, exactly as TopicManager.sendToTopic primes it.
  const a = await d1.turn(`<telepath>\n${outboxContract(outbox)}\n</telepath>\n\nReply with exactly the single word PONG and nothing else.`)
  check('text turn returns text', /PONG/i.test(a.text), JSON.stringify(a.text).slice(0, 60))
  sessionId = d1.st.sessionId
  check('session id captured after output', !!sessionId, sessionId ?? '(none)')

  const b = await d1.turn('Run the shell command `echo smoke` with the Bash tool. If the tool is denied, reply with exactly DENIED.')
  check('risky tool reaches canUseTool through the gate and deny is honoured', denied >= 1 && /DENIED/i.test(b.text), `denied=${denied} text=${JSON.stringify(b.text).slice(0, 40)}`)

  const c = await d1.turn('In one line: to which directory should you save a file you want the user to see? Answer with the path only.')
  check('primed outbox contract reaches the model', c.text.includes(outbox) || c.text.toLowerCase().includes('smoke-outbox'), JSON.stringify(c.text).slice(0, 80))
} finally {
  s1.close()
}

if (sessionId) {
  const s2 = backend.open({ topicId: 'smoke', cwd, model, effort, env, resume: sessionId, canUseTool: canUseTool as any, hooks })
  try {
    const d2 = new Driver(s2, sessionId)
    const d = await d2.turn('What single word did I ask you to reply with in my first message of this conversation? Answer with that word only.')
    check('resume by id continues the conversation', /PONG/i.test(d.text), JSON.stringify(d.text).slice(0, 40))
  } finally {
    s2.close()
  }
} else {
  check('resume by id continues the conversation', false, 'no session id to resume')
}

const failed = results.filter(r => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed in ${Math.round((Date.now() - t0) / 1000)}s (model ${model}${effort ? `, effort ${effort}` : ''})`)
process.exit(failed.length ? 1 : 0)
