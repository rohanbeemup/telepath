/**
 * A session profile: the locked shape every session of an install runs with. One set of
 * MCP servers, an explicit tool allowlist, no settings files, no prompts, a fixed working
 * directory and a prompt of its own. Parsed and validated here; applied in session.ts.
 *
 * Why the approval gate hook is left out: gate.ts answers `ask` for every tool outside
 * its read-only list, MCP tools included, and under `permissionMode: 'dontAsk'` an `ask`
 * is a denial. The hook's job (forcing a prompt past a settings allow rule) does not
 * exist when no settings are read and nothing may prompt.
 *
 * Why a hook of its own is put in: `dontAsk` denies only a tool that would have prompted,
 * and Claude Code auto-approves its read-only built-ins, so `allowedTools` alone is not
 * an exclusive list. The profile's hook answers `{}` for a listed tool and `deny` for any
 * other name, whatever the CLI auto-approves now or later.
 */
import { resolve } from 'path'
import type { Options } from '@anthropic-ai/claude-agent-sdk'
import { EFFORT_LEVELS, parseEffort, type Effort } from './models'
import type { OpenOptions } from './topics'

export type Profile = {
  name: string
  systemPrompt: string
  /** Built-in tools kept; empty = none. */
  tools: string[]
  mcpServers: NonNullable<Options['mcpServers']>
  /** `mcp__<server>__<tool>` entries, or a name from `tools`; auto-approved, everything else denied. */
  allowedTools: string[]
  cwd: string
  model?: string
  effort?: Effort
  maxTurns?: number
  maxBudgetUsd?: number
}

/** Where the profile file lives and how its neighbours are read; injected so parsing is pure. */
export type ProfileSource = {
  dir: string
  readFile: (path: string) => string
  isDirectory: (path: string) => boolean
}

export class ProfileError extends Error {
  constructor(public readonly problems: string[]) {
    super(`session profile:\n  - ${problems.join('\n  - ')}`)
    this.name = 'ProfileError'
  }
}

function stringList(v: unknown, key: string, problems: string[]): string[] {
  if (v === undefined) return []
  if (!Array.isArray(v) || !v.every(x => typeof x === 'string')) {
    problems.push(`${key} must be a list of strings`)
    return []
  }
  return v.map(s => s.trim()).filter(Boolean)
}

function positive(v: unknown, key: string, problems: string[]): number | undefined {
  if (v === undefined) return undefined
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
    problems.push(`${key} must be a positive number, got ${JSON.stringify(v)}`)
    return undefined
  }
  return v
}

/** Every problem at once, so a profile is fixed in one edit rather than one restart per field. */
export function parseProfile(raw: unknown, src: ProfileSource): Profile {
  const problems: string[] = []
  const o = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>
  if (o !== raw) problems.push('the profile must be a JSON object')

  const name = typeof o.name === 'string' && o.name.trim() ? o.name.trim() : 'profile'

  let systemPrompt = ''
  if (typeof o.systemPrompt === 'string') systemPrompt = o.systemPrompt
  else if (typeof o.systemPromptFile === 'string') {
    const path = resolve(src.dir, o.systemPromptFile) // an absolute path stays as it is
    try {
      systemPrompt = src.readFile(path)
    } catch (e) {
      problems.push(`systemPromptFile: cannot read ${path}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  if (!systemPrompt.trim()) problems.push('systemPrompt (or systemPromptFile) must hold a non-empty prompt: a profile session has no prompt of Claude Code\'s own')

  const tools = stringList(o.tools, 'tools', problems)
  if (tools.includes('AskUserQuestion')) {
    problems.push('tools: AskUserQuestion cannot work in a profile session: it never prompts (dontAsk), and an allowed tool is approved before a question could be shown, so the model would get an empty answer')
  }

  const servers = o.mcpServers && typeof o.mcpServers === 'object' && !Array.isArray(o.mcpServers) ? (o.mcpServers as Record<string, unknown>) : {}
  const serverNames = Object.keys(servers)
  if (!serverNames.length) problems.push('mcpServers must declare at least one server: it is all a profile session can reach')
  // Each entry is read here, not handed through: a typo would otherwise boot clean and fail in every topic.
  for (const [name, entry] of Object.entries(servers)) {
    const s = entry && typeof entry === 'object' && !Array.isArray(entry) ? (entry as Record<string, unknown>) : undefined
    if (!s) {
      problems.push(`mcpServers.${name}: must be an object with a type (http, sse or stdio)`)
      continue
    }
    // No type with a command is a stdio server: the SDK's own default, and the shape every .mcp.json uses.
    const type = s.type === undefined && typeof s.command === 'string' ? 'stdio' : s.type
    if (type === 'http' || type === 'sse') {
      if (typeof s.url !== 'string' || !s.url.trim()) problems.push(`mcpServers.${name}: a ${type} server needs a url`)
    } else if (type === 'stdio') {
      if (typeof s.command !== 'string' || !s.command.trim()) problems.push(`mcpServers.${name}: a stdio server needs a command`)
    } else {
      problems.push(`mcpServers.${name}: type must be http, sse or stdio; got ${JSON.stringify(s.type)}`)
    }
  }

  const allowedTools = stringList(o.allowedTools, 'allowedTools', problems)
  // With none, the hook denies every call in every topic and the bot boots as if fine.
  if (!allowedTools.length) problems.push('allowedTools must name at least one tool (mcp__<server>__<tool>); with none, every call in every topic is denied')
  for (const t of allowedTools) {
    if (t.includes('*')) {
      // The hook matches exact names, so a pattern would be accepted here and allow nothing there.
      problems.push(`allowedTools: ${t}: no patterns; name each tool`)
    } else if (t.startsWith('mcp__')) {
      const rest = t.slice('mcp__'.length)
      if (!serverNames.some(s => rest.startsWith(`${s}__`))) problems.push(`allowedTools: ${t} names no declared MCP server (declared: ${serverNames.join(', ') || 'none'})`)
    } else if (!tools.includes(t)) {
      problems.push(`allowedTools: ${t} is neither a tool of a declared MCP server (mcp__<server>__<tool>) nor a kept built-in tool (tools: ${tools.join(', ') || 'none'})`)
    }
  }
  for (const t of tools) {
    if (!allowedTools.includes(t)) problems.push(`tools: ${t} is kept but not in allowedTools, so the session would see a tool it may never call; allow it or drop it`)
  }

  // Resolved against the profile's directory, so the child is handed the same path that was checked.
  const cwd = typeof o.cwd === 'string' && o.cwd.trim() ? resolve(src.dir, o.cwd.trim()) : ''
  if (!cwd) problems.push('cwd must name the directory every session runs in')
  else if (!src.isDirectory(cwd)) problems.push(`cwd: ${cwd} is not a directory`)

  const model = typeof o.model === 'string' && o.model.trim() ? o.model.trim() : undefined
  let effort: Effort | undefined
  if (o.effort !== undefined) {
    effort = parseEffort(String(o.effort))
    if (!effort) problems.push(`effort must be one of ${EFFORT_LEVELS.join(', ')}; got ${JSON.stringify(o.effort)}`)
  }
  const maxTurns = positive(o.maxTurns, 'maxTurns', problems)
  const maxBudgetUsd = positive(o.maxBudgetUsd, 'maxBudgetUsd', problems)

  if (problems.length) throw new ProfileError(problems)
  return { name, systemPrompt, tools, mcpServers: servers as Profile['mcpServers'], allowedTools, cwd, model, effort, maxTurns, maxBudgetUsd }
}

/** The profile's PreToolUse answer: pass a listed tool, deny any other name. Pure. */
export function profileToolDecision(allowedTools: readonly string[], toolName: string): Record<string, unknown> {
  if (allowedTools.includes(toolName)) return {}
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `telepath profile: ${toolName || '(unnamed tool)'} is not an allowed tool`,
    },
  }
}

/**
 * The SDK options a profile session runs with; the backend adds its own binary and stderr.
 * The binding contributes only what the profile leaves open (model, effort) plus the
 * session to resume and the environment; its cwd never applies.
 */
export function profileOptions(p: Profile, open: OpenOptions): Options {
  const allowed = [...p.allowedTools]
  return {
    tools: [...p.tools],
    mcpServers: p.mcpServers,
    strictMcpConfig: true,
    allowedTools: allowed,
    permissionMode: 'dontAsk',
    settingSources: [],
    // Stream deltas count as output: in a shared forum a turn is "stuck" only when no tokens
    // are flowing, so a long answer is never killed as silent (security read).
    includePartialMessages: true,
    systemPrompt: p.systemPrompt,
    cwd: p.cwd,
    model: p.model ?? open.model,
    effort: p.effort ?? open.effort,
    maxTurns: p.maxTurns,
    // The stretch's remaining budget when the topic manager passes one; the cap otherwise.
    maxBudgetUsd: open.budgetUsd ?? p.maxBudgetUsd,
    resume: open.resume,
    env: open.env,
    // No canUseTool: under dontAsk the CLI never prompts, so the Telegram Allow/Deny gate
    // would be dead configuration. The allowlist, enforced, is the hook below.
    hooks: { PreToolUse: [{ hooks: [async (input: any) => profileToolDecision(allowed, String(input?.tool_name ?? '')) as any] }] },
  }
}

/**
 * A model name is passed to the SDK as given, so a typo would boot clean and fail in every
 * topic (under a profile, without its detail): it must be one of the install's catalog ids.
 * None set means the binding's default applies.
 */
export function profileModelProblem(p: Profile, knownIds: string[]): string | undefined {
  if (p.model === undefined || knownIds.includes(p.model)) return undefined
  return `model: ${p.model} is not one of this install's model ids (${knownIds.join(', ')}); use one of them, or set OPUS_MODEL and friends in .env`
}

/** What team mode needs of a profile beyond what any profile needs; the daemon refuses to boot on these. */
export function teamProfileProblems(p: Profile): string[] {
  const problems: string[] = []
  if (p.maxBudgetUsd === undefined) problems.push('maxBudgetUsd is required in team mode: a shared forum needs a per-topic cap, or any member can spend without limit')
  // Every built-in reaches the host or the network from the box (a shell, the files, which hold
  // the .env, the web), which no member may: team mode runs on the profile's MCP servers alone.
  if (p.tools.length) problems.push(`tools: team mode keeps no built-in tool (${p.tools.join(', ')}); a shared forum reaches only the profile's MCP servers`)
  return problems
}
