/**
 * The SDK boundary: the only module that imports runtime values from
 * @anthropic-ai/claude-agent-sdk. A resident session is `query()` fed by a Mailbox that
 * stays open for the topic's lifetime; `close()` ends the mailbox and terminates the
 * claude process.
 */
import { query, listSessions as sdkListSessions, type SDKUserMessage, type SettingSource, type Options } from '@anthropic-ai/claude-agent-sdk'
import { Mailbox, userMessage } from './mailbox'
import type { LiveSession, OpenOptions, SessionBackend } from './topics'
import type { Logger } from './log'

export type SdkBackendOptions = {
  settingSources: SettingSource[]
  /** Override for the SDK's bundled binary; undefined = bundled. */
  pathToClaudeCodeExecutable?: string
  log: Logger
}

export class SdkBackend implements SessionBackend {
  constructor(private readonly o: SdkBackendOptions) {}

  open(opts: OpenOptions): LiveSession {
    const inbox = new Mailbox<SDKUserMessage>()
    const options: Options = {
      model: opts.model,
      effort: opts.effort,
      cwd: opts.cwd,
      env: opts.env,
      resume: opts.resume,
      settingSources: this.o.settingSources,
      permissionMode: 'default',
      // No `allowedTools`: a bare entry there auto-approves the tool BEFORE canUseTool
      // is consulted (the SDK warns about it). The read-only auto-allow list lives in
      // the callback instead, so one gate sees every call and the counters are honest.
      canUseTool: opts.canUseTool,
      hooks: opts.hooks,
      pathToClaudeCodeExecutable: this.o.pathToClaudeCodeExecutable,
      stderr: (line: string) => this.o.log.debug('claude.stderr', { topic: opts.topicId, line: line.trimEnd() }),
    }
    const q = query({ prompt: inbox, options })
    let closed = false
    return {
      send: (text: string) => {
        if (closed) throw new Error('session is closed')
        inbox.push(userMessage(text) as SDKUserMessage)
      },
      stream: () => q,
      close: () => {
        if (closed) return
        closed = true
        inbox.close()
        try {
          q.close()
        } catch {}
      },
    }
  }
}

export type SessionInfo = { sessionId: string; summary: string; lastModified: number; customTitle?: string; firstPrompt?: string; cwd?: string }

export async function listSessions(): Promise<SessionInfo[]> {
  const rows = await sdkListSessions()
  return rows.map(r => ({ sessionId: r.sessionId, summary: r.summary, lastModified: r.lastModified, customTitle: r.customTitle, firstPrompt: r.firstPrompt, cwd: r.cwd }))
}
