import { test, expect, describe, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { loadStore, StateError } from './state'
import { buildCatalog } from './models'

const catalog = buildCatalog({
  ids: { haiku: 'claude-haiku-4-5', sonnet: 'claude-sonnet-5', opus: 'claude-opus-5', fable: 'claude-fable-5-1' },
  enabled: ['sonnet', 'opus'],
})
const defaults = { defaultModel: 'claude-opus-5', defaultCwd: '/work', defaultEffort: 'high' as const }

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'telepath-state-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('prefs', () => {
  test('persists a cleared default effort as null so it survives a restart', () => {
    const s1 = loadStore(dir, defaults, catalog)
    expect(s1.prefs.defaultEffort).toBe('high')
    s1.prefs.defaultEffort = undefined
    s1.savePrefs()
    expect(JSON.parse(readFileSync(join(dir, 'prefs.json'), 'utf8')).defaultEffort).toBeNull()
    const s2 = loadStore(dir, defaults, catalog)
    expect(s2.prefs.defaultEffort).toBeUndefined()
  })

  test('an absent effort key falls back to the configured default', () => {
    writeFileSync(join(dir, 'prefs.json'), JSON.stringify({ defaultModel: 'claude-opus-5', defaultCwd: '/work' }))
    expect(loadStore(dir, defaults, catalog).prefs.defaultEffort).toBe('high')
  })

  test('drops a garbage effort value from an old prefs file', () => {
    writeFileSync(join(dir, 'prefs.json'), JSON.stringify({ defaultModel: 'claude-opus-5', defaultCwd: '/work', defaultEffort: 'turbo' }))
    expect(loadStore(dir, defaults, catalog).prefs.defaultEffort).toBeUndefined()
  })
})

describe('registry', () => {
  test('writes atomically through a temp file and rename', () => {
    const s = loadStore(dir, defaults, catalog)
    s.registry['1'] = { cwd: '/work', model: 'claude-opus-5', title: 't', lastActive: 1 }
    s.saveRegistry()
    expect(JSON.parse(readFileSync(join(dir, 'registry.json'), 'utf8'))['1'].title).toBe('t')
    expect(readdirSync(dir).filter(n => n.endsWith('.tmp'))).toEqual([])
  })

  test('refuses to start on a malformed registry instead of overwriting it', () => {
    const file = join(dir, 'registry.json')
    writeFileSync(file, '{"1": {"cwd": "/w", "model": "claude-opus-5", "title": "a", "lastActive": 1')
    expect(() => loadStore(dir, defaults, catalog)).toThrow(StateError)
    // the file is untouched, so the bindings can still be repaired by hand
    expect(readFileSync(file, 'utf8')).toContain('"title": "a"')
    // a missing file is not an error: a fresh install starts empty
    rmSync(file)
    expect(Object.keys(loadStore(dir, defaults, catalog).registry)).toEqual([])
  })

  test('migrates bindings off a disabled model at load', () => {
    writeFileSync(
      join(dir, 'registry.json'),
      JSON.stringify({ '1': { cwd: '/w', model: 'claude-fable-5-1', title: 'a', lastActive: 1 }, '2': { cwd: '/w', model: 'claude-opus-5', title: 'b', lastActive: 1 } }),
    )
    const s = loadStore(dir, defaults, catalog)
    expect(s.registry['1'].model).toBe('claude-opus-5')
    expect(s.registry['2'].model).toBe('claude-opus-5')
    // migrated state is written back, so the next boot does not redo it
    expect(JSON.parse(readFileSync(join(dir, 'registry.json'), 'utf8'))['1'].model).toBe('claude-opus-5')
  })
})
