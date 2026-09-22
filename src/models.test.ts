import { test, expect, describe } from 'bun:test'
import { parseEffort, supportsEffort, effortFor, isModelKey, buildCatalog, EFFORT_LEVELS } from './models'

const catalog = buildCatalog({
  ids: { haiku: 'claude-haiku-4-5', sonnet: 'claude-sonnet-5', opus: 'claude-opus-5', fable: 'claude-fable-5-1' },
  enabled: ['haiku', 'sonnet', 'opus', 'fable'],
})

describe('effort', () => {
  test('parses the five effort levels case-insensitively and nothing else', () => {
    for (const e of EFFORT_LEVELS) expect(parseEffort(e.toUpperCase())).toBe(e)
    expect(parseEffort(' high ')).toBe('high')
    for (const bad of ['', 'turbo', 'default', undefined, 'auto']) expect(parseEffort(bad)).toBeUndefined()
  })

  test('haiku accepts no effort level, the other packages accept all five', () => {
    expect(supportsEffort(catalog, 'claude-haiku-4-5')).toBe(false)
    for (const id of ['claude-sonnet-5', 'claude-opus-5', 'claude-fable-5-1']) expect(supportsEffort(catalog, id)).toBe(true)
    expect(supportsEffort(catalog, 'claude-unknown')).toBe(false)
  })

  test('a binding on a model without effort levels runs without one but keeps its choice', () => {
    const b = { model: 'claude-haiku-4-5', effort: 'max' as const }
    expect(effortFor(catalog, b)).toBeUndefined()
    expect(b.effort).toBe('max')
    expect(effortFor(catalog, { model: 'claude-fable-5-1', effort: 'max' })).toBe('max')
  })
})

describe('model keys', () => {
  test('does not let a prototype name pass as a model key', () => {
    for (const k of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) expect(isModelKey(catalog, k)).toBe(false)
    expect(isModelKey(catalog, 'fable')).toBe(true)
    expect(isModelKey(catalog, 'FABLE')).toBe(false)
  })
})
