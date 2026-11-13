import { test, expect, describe } from 'bun:test'
import { join } from 'path'
import { parseProfile, profileOptions, teamProfileProblems, profileModelProblem, ProfileError, type ProfileSource } from './profile'
import type { OpenOptions } from './topics'

const DIR = '/srv/bot'
const WORK = join(DIR, 'work')

function source(files: Record<string, string> = {}, dirs: string[] = [WORK]): ProfileSource {
  return {
    dir: DIR,
    readFile: p => {
      if (!(p in files)) throw new Error(`ENOENT: ${p}`)
      return files[p]
    },
    isDirectory: p => dirs.includes(p),
  }
}

const SERVERS = { kb: { type: 'http' as const, url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer x' } } }

const raw = (over: Record<string, unknown> = {}) => ({
  name: 'helpdesk',
  systemPrompt: 'Answer from the knowledge tools only.',
  mcpServers: SERVERS,
  allowedTools: ['mcp__kb__search', 'mcp__kb__read'],
  cwd: WORK,
  model: 'claude-opus-5',
  effort: 'medium',
  maxTurns: 30,
  maxBudgetUsd: 1.5,
  ...over,
})

/** What a binding would open today: a repo, another model, the approval gate hook. */
const gateHook = { PreToolUse: [{ hooks: [async () => ({})] }] }
const open = (over: Partial<OpenOptions> = {}): OpenOptions => ({
  topicId: '7',
  cwd: '/home/someone/repo',
  model: 'claude-sonnet-5',
  effort: 'max',
  resume: 'sess-1',
  env: { PATH: '/bin', TELEPATH_OUTBOX: '/out/7' },
  canUseTool: (async () => ({ behavior: 'deny', message: 'x' })) as any,
  hooks: gateHook as any,
  ...over,
})

describe('a profile session', () => {
  test("a profile session runs with no built-in tools and only the profile's MCP servers", () => {
    // and streams its deltas: in a shared forum "stuck" means no tokens flowing, so a long answer is never killed as silent
    expect(profileOptions(parseProfile(raw(), source()), open()).includePartialMessages).toBe(true)
    const o = profileOptions(parseProfile(raw(), source()), open())
    expect(o.tools).toEqual([])
    expect(o.mcpServers).toEqual(SERVERS)
    expect(o.strictMcpConfig).toBe(true)
    // a profile may keep a built-in tool by naming it
    const kept = profileOptions(parseProfile(raw({ tools: ['WebFetch'], allowedTools: ['mcp__kb__search', 'WebFetch'] }), source()), open())
    expect(kept.tools).toEqual(['WebFetch'])
  })

  test("a profile session auto-allows exactly the profile's tools and never prompts", () => {
    const o = profileOptions(parseProfile(raw(), source()), open())
    expect(o.allowedTools).toEqual(['mcp__kb__search', 'mcp__kb__read'])
    expect(o.permissionMode).toBe('dontAsk')
  })

  test('a profile session reads no settings files and its only hook denies every tool outside the allowlist', async () => {
    const o = profileOptions(parseProfile(raw(), source()), open())
    expect(o.settingSources).toEqual([])
    const matchers = o.hooks?.PreToolUse ?? []
    expect(matchers.length).toBe(1)
    expect(matchers[0].hooks.length).toBe(1)
    expect(Object.keys(o.hooks ?? {})).toEqual(['PreToolUse'])
    const hook = matchers[0].hooks[0]
    const decide = async (tool_name: string) => hook({ tool_name } as any, undefined, { signal: new AbortController().signal })
    expect(await decide('mcp__kb__search')).toEqual({})
    expect(await decide('mcp__kb__read')).toEqual({})
    for (const denied of ['Read', 'Bash', 'mcp__other__search', 'mcp__kb__delete', '']) {
      const out = (await decide(denied)) as { hookSpecificOutput?: { permissionDecision?: string } }
      expect([denied, out.hookSpecificOutput?.permissionDecision]).toEqual([denied, 'deny'])
    }
  })

  test("a profile session uses the profile's prompt, cwd, model, effort and caps, not the binding's", () => {
    const o = profileOptions(parseProfile(raw(), source()), open())
    expect(o.systemPrompt).toBe('Answer from the knowledge tools only.')
    expect(o.cwd).toBe(WORK)
    expect(o.model).toBe('claude-opus-5')
    expect(o.effort).toBe('medium')
    expect(o.maxTurns).toBe(30)
    expect(o.maxBudgetUsd).toBe(1.5)
    expect(o.resume).toBe('sess-1')
    expect(o.env).toEqual({ PATH: '/bin', TELEPATH_OUTBOX: '/out/7' })
    // a profile that names no model or effort takes the topic's
    const fallback = profileOptions(parseProfile(raw({ model: undefined, effort: undefined }), source()), open())
    expect(fallback.model).toBe('claude-sonnet-5')
    expect(fallback.effort).toBe('max')
    // a stretch opened with what is left of the topic's budget runs on that, not the full cap
    expect(profileOptions(parseProfile(raw(), source()), open({ budgetUsd: 0.4 })).maxBudgetUsd).toBe(0.4)
  })

  test("a profile's prompt file and cwd resolve against the profile's directory, absolute paths as given", () => {
    const p = parseProfile(raw({ systemPrompt: undefined, systemPromptFile: 'prompt.md' }), source({ [join(DIR, 'prompt.md')]: 'From the file.' }))
    expect(p.systemPrompt).toBe('From the file.')
    const abs = join('/etc', 'telepath', 'prompt.md')
    const q = parseProfile(raw({ systemPrompt: undefined, systemPromptFile: abs }), source({ [abs]: 'Absolute.' }))
    expect(q.systemPrompt).toBe('Absolute.')
    // a relative cwd is the profile directory's, checked and handed on resolved
    const r = parseProfile(raw({ cwd: 'work' }), source())
    expect(r.cwd).toBe(WORK)
    expect(profileOptions(r, open()).cwd).toBe(WORK)
  })
})

describe('a profile is refused when', () => {
  test('a profile names its MCP servers, a non-empty prompt and an existing cwd, or is refused', () => {
    let err: unknown
    try {
      parseProfile(raw({ mcpServers: {}, systemPrompt: '   ', cwd: '/nowhere' }), source())
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(ProfileError)
    const msg = String((err as Error).message)
    for (const k of ['mcpServers', 'systemPrompt', 'cwd']) expect(msg).toContain(k)
    // each server entry is read, not passed through: a typo in url, a missing command, an unknown type
    for (const servers of [
      { kb: { type: 'http', urll: 'https://mcp.example.com/mcp' } },
      { kb: { type: 'sse' } },
      { kb: { type: 'stdio', args: ['x'] } },
      { kb: { type: 'carrier-pigeon', url: 'https://mcp.example.com/mcp' } },
      { kb: 'https://mcp.example.com/mcp' },
    ]) {
      let e: unknown
      try {
        parseProfile(raw({ mcpServers: servers }), source())
      } catch (x) {
        e = x
      }
      expect(e).toBeInstanceOf(ProfileError)
      expect(String((e as Error).message)).toContain('kb')
    }
    expect(() => parseProfile(raw({ mcpServers: { local: { type: 'stdio', command: 'kb-server', args: ['--port', '0'] } }, allowedTools: ['mcp__local__search'] }), source())).not.toThrow()
    // a command with no type is a stdio server: the SDK's own default and the shape every .mcp.json uses
    expect(() => parseProfile(raw({ mcpServers: { local: { command: 'kb-server' } }, allowedTools: ['mcp__local__search'] }), source())).not.toThrow()
    // a command with a path in it resolves against the profile's directory, like cwd; a bare name is the child's PATH to find
    const local = parseProfile(raw({ mcpServers: { local: { command: './kb-server.js' } }, allowedTools: ['mcp__local__search'] }), source()).mcpServers.local as { type?: string; command?: string }
    expect(local.command).toBe(join(DIR, 'kb-server.js'))
    expect(local.type).toBe('stdio')
    const bare = parseProfile(raw({ mcpServers: { local: { command: 'kb-server' } }, allowedTools: ['mcp__local__search'] }), source()).mcpServers.local as { command?: string }
    expect(bare.command).toBe('kb-server')
    // and an argument that is explicitly relative, while a flag, a URL, a scoped package name or `--flag=./x` stays as typed
    const withArgs = parseProfile(
      raw({ mcpServers: { local: { command: 'npx', args: ['-y', '@scope/server', './server.py', '../bin/x', 'https://kb.example.com/mcp', '--config=./c.json'] } }, allowedTools: ['mcp__local__search'] }),
      source(),
    ).mcpServers.local as { args?: string[] }
    expect(withArgs.args).toEqual(['-y', '@scope/server', join(DIR, 'server.py'), join(DIR, '..', 'bin', 'x'), 'https://kb.example.com/mcp', '--config=./c.json'])
  })

  test('an allowed tool must name a declared MCP server or a kept built-in tool', () => {
    expect(() => parseProfile(raw({ allowedTools: ['mcp__kb__search', 'mcp__other__search'] }), source())).toThrow(ProfileError)
    expect(() => parseProfile(raw({ allowedTools: ['Bash'] }), source())).toThrow(ProfileError)
    expect(() => parseProfile(raw({ tools: ['WebFetch'], allowedTools: ['WebFetch'] }), source())).not.toThrow()
    // no patterns: the hook matches exact names, so a pattern would be accepted here and allow nothing there
    expect(() => parseProfile(raw({ allowedTools: ['mcp__kb__*'] }), source())).toThrow(/no patterns/)
    // and at least one: with none, every call in every topic is denied while the boot looks fine
    expect(() => parseProfile(raw({ allowedTools: [] }), source())).toThrow(/at least one/)
    expect(() => parseProfile(raw({ allowedTools: undefined }), source())).toThrow(/at least one/)
    // the converse: a kept built-in that is not allowed is a tool the hook would deny on every call
    expect(() => parseProfile(raw({ tools: ['Read'] }), source())).toThrow(ProfileError)
    // a question tool can never prompt in a profile session, so it is refused outright
    expect(() => parseProfile(raw({ tools: ['AskUserQuestion'], allowedTools: ['mcp__kb__search', 'AskUserQuestion'] }), source())).toThrow(ProfileError)
  })

  test("a profile's model must be one of the catalog's ids", () => {
    const p = parseProfile(raw(), source())
    expect(profileModelProblem(p, ['claude-opus-5', 'claude-sonnet-5'])).toBeUndefined()
    expect(profileModelProblem(p, ['claude-sonnet-5'])).toMatch(/^model: claude-opus-5 /)
    // none set: the binding's default applies, nothing to check
    expect(profileModelProblem(parseProfile(raw({ model: undefined }), source()), ['claude-sonnet-5'])).toBeUndefined()
  })

  test('team mode refuses a profile without a budget', () => {
    expect(teamProfileProblems(parseProfile(raw(), source()))).toEqual([])
    const problems = teamProfileProblems(parseProfile(raw({ maxBudgetUsd: undefined }), source()))
    expect(problems.length).toBe(1)
    expect(problems[0]).toContain('maxBudgetUsd')
    // and one that keeps any built-in tool: a shell, the files (the .env among them) or the web from the box
    const shell = teamProfileProblems(parseProfile(raw({ tools: ['Read', 'WebFetch'], allowedTools: ['mcp__kb__search', 'Read', 'WebFetch'] }), source()))
    expect(shell.length).toBe(1)
    expect(shell[0]).toMatch(/^tools: .*Read, WebFetch/)
  })
})
