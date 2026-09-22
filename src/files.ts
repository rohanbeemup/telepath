/**
 * Files both ways: the per-topic outbox a session drops deliverables into, the inbox
 * Telegram uploads land in, and transcript removal for the full wipe.
 */
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { basename, join } from 'path'

const IMG_RE = /\.(png|jpe?g|gif|webp|bmp)$/i

export function isImage(path: string): boolean {
  return IMG_RE.test(path)
}

export class Files {
  readonly outboxBase: string
  readonly inboxDir: string

  constructor(stateDir: string) {
    this.outboxBase = join(stateDir, 'outbox')
    this.inboxDir = join(stateDir, 'inbox')
  }

  outboxDir(topicId: string): string {
    const dir = join(this.outboxBase, topicId)
    try {
      mkdirSync(dir, { recursive: true })
    } catch {}
    return dir
  }

  removeOutbox(topicId: string): void {
    try {
      rmSync(join(this.outboxBase, topicId), { recursive: true, force: true })
    } catch {}
  }

  /** Regular files waiting in a topic's outbox (the legacy `sent` archive is skipped). */
  pendingOutbox(topicId: string): string[] {
    const dir = join(this.outboxBase, topicId)
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      return []
    }
    const out: string[] = []
    for (const name of names) {
      if (name === 'sent') continue
      const p = join(dir, name)
      try {
        if (statSync(p).isFile()) out.push(p)
      } catch {}
    }
    return out
  }

  /** After Telegram accepted a file: delete it, or archive it if deletion fails so it is not re-sent. */
  afterSent(path: string): void {
    try {
      rmSync(path, { force: true })
    } catch {
      try {
        const sentDir = join(path, '..', 'sent')
        mkdirSync(sentDir, { recursive: true })
        renameSync(path, join(sentDir, basename(path)))
      } catch {}
    }
  }

  saveInbox(name: string, data: Uint8Array): string {
    mkdirSync(this.inboxDir, { recursive: true })
    const safe = name.replace(/[^\w.\-]/g, '_')
    const path = join(this.inboxDir, `${Date.now()}-${safe}`)
    writeFileSync(path, data)
    return path
  }
}

/** Delete a session's transcript from ~/.claude/projects (makes it unresumable). */
export function deleteTranscript(sessionId: string, projectsDir = join(homedir(), '.claude', 'projects')): string[] {
  const removed: string[] = []
  let projects: string[]
  try {
    projects = readdirSync(projectsDir)
  } catch {
    return removed
  }
  for (const p of projects) {
    const f = join(projectsDir, p, `${sessionId}.jsonl`)
    try {
      if (existsSync(f)) {
        rmSync(f, { force: true })
        removed.push(f)
      }
    } catch {}
  }
  return removed
}

/** Candidate working dirs: the default first, then every project under reposDir (git repos first, newest first), then home. */
export function listRepoFolders(reposDir: string, defaultCwd: string): string[] {
  const entries: { path: string; mtime: number; git: boolean }[] = []
  try {
    for (const name of readdirSync(reposDir)) {
      if (name.startsWith('.')) continue
      const p = join(reposDir, name)
      try {
        const st = statSync(p)
        if (!st.isDirectory()) continue
        entries.push({ path: p, mtime: st.mtimeMs, git: existsSync(join(p, '.git')) })
      } catch {}
    }
  } catch {}
  entries.sort((a, b) => Number(b.git) - Number(a.git) || b.mtime - a.mtime)
  return [...new Set([defaultCwd, ...entries.map(e => e.path), homedir()])]
}
