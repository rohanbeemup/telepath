/**
 * Seed-request binder: an external process (the todo queue) creates a forum topic for a
 * headless run and drops a JSON request here; the daemon drains the directory on a timer
 * and binds each topic to that run's resumable session, so a person can continue the work
 * by typing in the topic once the run has finished.
 *
 * telepath owns registry.json in memory and only ever writes it, so a binding poked into
 * the file from outside would be invisible until a restart. This is the supported seam for
 * adding one from another process: a file in, a binding out, done by the daemon itself.
 *
 * The request is honoured only AFTER the run's own process has exited (the todo queue writes
 * it at finish, never at start), so telepath never opens a second process on a transcript the
 * headless run is still writing.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync } from 'fs'
import { join } from 'path'
import type { Binding, Registry } from './state'
import type { Logger } from './log'

/** The minimal store surface the binder needs; satisfied by `Store`, faked in tests. */
export type SeedStore = { registry: Registry; saveRegistry(): void }

export type SeedRequest = {
  topicId: string
  sessionId: string
  cwd: string
  model: string
  title: string
}

const REQUIRED: (keyof SeedRequest)[] = ['topicId', 'sessionId', 'cwd', 'model', 'title']

/**
 * Refused requests that could not be set aside and were said: a file that stays is said once per
 * process rather than every drain (a restart says it again, once).
 */
const saidStuck = new Set<string>()

/**
 * Move a refused request under `refused/` beside the others, under a name not already there (a
 * later request that reuses a filename must not land on an earlier one; Codex hook); where it
 * went, or undefined when it could not be moved.
 */
function setAside(dir: string, name: string, path: string): string | undefined {
  const aside = join(dir, 'refused')
  try {
    mkdirSync(aside, { recursive: true })
    let to = join(aside, name)
    for (let n = 1; existsSync(to); n++) to = join(aside, `${n}-${name}`)
    renameSync(path, to)
    return to
  } catch {
    return undefined
  }
}

function parse(raw: string): SeedRequest | undefined {
  let obj: unknown
  try {
    obj = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!obj || typeof obj !== 'object') return undefined
  const o = obj as Record<string, unknown>
  for (const k of REQUIRED) if (typeof o[k] !== 'string' || !(o[k] as string).length) return undefined
  return { topicId: o.topicId as string, sessionId: o.sessionId as string, cwd: o.cwd as string, model: o.model as string, title: o.title as string }
}

/**
 * Bind every well-formed request in `dir`, newest filename last so a later request for a
 * topic wins. Each file is deleted after it is read — valid or not — so a malformed one is
 * logged once and never loops. Returns the topic ids newly bound, for the caller to paint
 * controls into. The registry is saved once, only when something was bound.
 *
 * Under a session profile (`profile`) every request is refused, said once in the log and
 * set aside under `refused/` (it is valid, so a later run without the profile can still
 * serve it by hand): the profile owns every session's options, so the run's transcript
 * would be dropped on the topic's first message anyway, and in a shared forum it would
 * sit bound to a member-visible topic until then.
 */
export function drainSeedRequests(dir: string, store: SeedStore, now: () => number, log?: Logger, profile = false): string[] {
  let names: string[]
  try {
    names = readdirSync(dir).filter(n => n.endsWith('.json')).sort()
  } catch {
    return [] // no dir yet: nothing to do
  }
  const bound: string[] = []
  for (const name of names) {
    const path = join(dir, name)
    let raw: string
    try {
      raw = readFileSync(path, 'utf8')
    } catch {
      continue // vanished between listing and read
    }
    const req = parse(raw)
    if (!req) {
      log?.warn('seed.malformed', { file: name })
    } else if (profile) {
      const keptAt = setAside(dir, name, path)
      const reason = 'a session profile owns every session; the run is not resumed'
      if (keptAt) log?.warn('seed.refused', { topic: req.topicId, sessionId: req.sessionId, keptAt, reason })
      else if (!saidStuck.has(path)) {
        // Never deleted: the request is valid, and an archival failure must not lose it (Codex hook).
        saidStuck.add(path)
        log?.warn('seed.refused', { topic: req.topicId, sessionId: req.sessionId, keptAt: path, reason, note: 'could not be moved under refused/; left where it is' })
      }
      continue
    } else {
      const b: Binding = { sessionId: req.sessionId, cwd: req.cwd, model: req.model, title: req.title, lastActive: now(), auto: false }
      store.registry[req.topicId] = b
      bound.push(req.topicId)
      log?.info('seed.bound', { topic: req.topicId, sessionId: req.sessionId, cwd: req.cwd })
    }
    try {
      unlinkSync(path)
    } catch {}
  }
  if (bound.length) store.saveRegistry()
  return bound
}
