/**
 * Boot checks. Each returns a verdict rather than throwing, so the daemon can print
 * every problem at once and decide which are fatal. A check that cannot run reports
 * that, never "ok".
 */
import { existsSync } from 'fs'
import { join } from 'path'

/** The Claude 5 models refuse older CLIs with `claude_code_version_too_old`. */
export const MIN_CLAUDE_VERSION = '2.1.251'

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(n => parseInt(n, 10) || 0)
  const pb = b.split('.').map(n => parseInt(n, 10) || 0)
  const n = Math.max(pa.length, pb.length)
  for (let i = 0; i < n; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

export type Verdict = { ok: boolean; message: string }

/** `versionOutput` is what `claude --version` printed, e.g. "2.1.278 (Claude Code)". */
export function checkClaudeVersion(versionOutput: string | undefined, min: string): Verdict {
  const m = versionOutput ? /(\d+\.\d+\.\d+)/.exec(versionOutput) : null
  if (!m) return { ok: false, message: `could not read the claude binary's version (got ${JSON.stringify(versionOutput ?? '')})` }
  const v = m[1]
  if (compareVersions(v, min) < 0) {
    return { ok: false, message: `claude binary is ${v}; the Claude 5 models need ${min} or newer (claude_code_version_too_old). Upgrade @anthropic-ai/claude-agent-sdk or point CLAUDE_BINARY at a newer Claude Code.` }
  }
  return { ok: true, message: `claude binary ${v}` }
}

/** Where the SDK's bundled Claude Code binary lives for this platform, if installed. */
export function bundledClaudePath(rootDir: string): string | undefined {
  const isWin = process.platform === 'win32'
  const exe = isWin ? 'claude.exe' : 'claude'
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  const candidates = isWin
    ? [`claude-agent-sdk-win32-${arch}`]
    : process.platform === 'darwin'
      ? [`claude-agent-sdk-darwin-${arch}`]
      : [`claude-agent-sdk-linux-${arch}`, `claude-agent-sdk-linux-${arch}-musl`]
  for (const c of candidates) {
    const p = join(rootDir, 'node_modules', '@anthropic-ai', c, exe)
    if (existsSync(p)) return p
  }
  return undefined
}

/** Runs `<bin> --version` with a timeout; undefined when it cannot be read. */
export async function readClaudeVersion(bin: string, timeoutMs = 15_000): Promise<string | undefined> {
  try {
    const proc = Bun.spawn([bin, '--version'], { stdout: 'pipe', stderr: 'ignore', stdin: 'ignore' })
    const timer = setTimeout(() => proc.kill(), timeoutMs)
    const out = await new Response(proc.stdout).text()
    clearTimeout(timer)
    return out.trim() || undefined
  } catch {
    return undefined
  }
}
