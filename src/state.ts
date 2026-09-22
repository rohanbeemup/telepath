/**
 * Persisted state: registry.json (topic → session binding) and prefs.json (defaults the
 * Settings menu edits). Both are written atomically through a temp file and a rename,
 * so a crash mid-write cannot leave a truncated file behind.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { parseEffort, type Catalog, type Effort } from './models'

export type Binding = {
  sessionId?: string
  cwd: string
  model: string
  effort?: Effort
  title: string
  lastActive: number
  auto?: boolean
  /** Activity feed override; unset = on in auto mode, off under approvals. */
  feed?: boolean
  controlMsgId?: number
}
export type Registry = Record<string, Binding>
export type Prefs = { defaultModel: string; defaultCwd: string; defaultEffort?: Effort }

export type StoreDefaults = { defaultModel: string; defaultCwd: string; defaultEffort?: Effort }

/** Unset = on in auto mode, where nothing else shows what the session is doing. */
export function feedOn(b: Binding): boolean {
  return b.feed ?? !!b.auto
}

function writeAtomic(file: string, data: unknown): void {
  mkdirSync(join(file, '..'), { recursive: true })
  const tmp = file + '.tmp'
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n')
  renameSync(tmp, file)
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

export class Store {
  readonly registryFile: string
  readonly prefsFile: string
  registry: Registry
  prefs: Prefs

  constructor(
    readonly dir: string,
    registry: Registry,
    prefs: Prefs,
    private readonly defaults: StoreDefaults,
  ) {
    this.registryFile = join(dir, 'registry.json')
    this.prefsFile = join(dir, 'prefs.json')
    this.registry = registry
    this.prefs = prefs
  }

  saveRegistry(): void {
    writeAtomic(this.registryFile, this.registry)
  }

  savePrefs(): void {
    // null, not undefined: JSON drops an undefined key, and an absent key means
    // "never chosen" (falls back to the .env default) rather than "cleared".
    writeAtomic(this.prefsFile, { ...this.prefs, defaultEffort: this.prefs.defaultEffort ?? null })
  }

  /** The saved default folder can vanish between runs; never hand a dead path to the SDK. */
  defaultCwd(): string {
    try {
      if (statSync(this.prefs.defaultCwd).isDirectory()) return this.prefs.defaultCwd
    } catch {}
    return this.defaults.defaultCwd
  }
}

/**
 * Load both files, applying the two migrations that keep an old state usable:
 * a garbage effort value is dropped, and a binding on a package no longer enabled
 * moves to the default model (and is written back so the next boot does not redo it).
 */
export function loadStore(dir: string, defaults: StoreDefaults, catalog: Catalog): Store {
  const rawRegistry = readJson(join(dir, 'registry.json'))
  const registry: Registry = rawRegistry && typeof rawRegistry === 'object' ? (rawRegistry as Registry) : {}

  const rawPrefs = readJson(join(dir, 'prefs.json'))
  const p = rawPrefs && typeof rawPrefs === 'object' ? (rawPrefs as Record<string, unknown>) : {}
  const prefs: Prefs = {
    defaultModel: typeof p.defaultModel === 'string' ? p.defaultModel : defaults.defaultModel,
    defaultCwd: typeof p.defaultCwd === 'string' ? p.defaultCwd : defaults.defaultCwd,
    // Key present (even null) = the user chose; only an absent key inherits the .env default.
    defaultEffort: 'defaultEffort' in p ? parseEffort(typeof p.defaultEffort === 'string' ? p.defaultEffort : undefined) : defaults.defaultEffort,
  }
  const enabledIds = new Set(catalog.enabled.map(k => catalog.ids[k]))
  if (!enabledIds.has(prefs.defaultModel)) prefs.defaultModel = defaults.defaultModel

  let migrated = false
  for (const b of Object.values(registry)) {
    if (!enabledIds.has(b.model)) {
      b.model = prefs.defaultModel
      migrated = true
    }
    if (b.effort !== undefined && !parseEffort(b.effort)) {
      delete b.effort
      migrated = true
    }
  }

  const store = new Store(dir, registry, prefs, defaults)
  if (migrated || (existsSync(join(dir, 'registry.json')) && rawRegistry === undefined)) store.saveRegistry()
  return store
}
