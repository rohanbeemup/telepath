import { test, expect, describe, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { drainSeedRequests, type SeedStore, type SeedRequest } from './seed'

let dir: string
let saves: number
let store: SeedStore

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'seed-'))
  saves = 0
  store = { registry: {}, saveRegistry: () => void saves++ }
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function drop(name: string, req: Partial<SeedRequest> | string): void {
  writeFileSync(join(dir, name), typeof req === 'string' ? req : JSON.stringify(req))
}

const good = (over: Partial<SeedRequest> = {}): SeedRequest => ({
  topicId: '555', sessionId: 'sess-abc', cwd: '/w/todo-T9', model: 'claude-opus-4-8', title: '🚨 T9', ...over,
})

describe('drainSeedRequests', () => {
  test('binds a well-formed request as an attended session and deletes the file', () => {
    drop('1.json', good())
    const bound = drainSeedRequests(dir, store, () => 1000)
    expect(bound).toEqual(['555'])
    expect(store.registry['555']).toEqual({
      sessionId: 'sess-abc', cwd: '/w/todo-T9', model: 'claude-opus-4-8', title: '🚨 T9', lastActive: 1000, auto: false,
    })
    expect(saves).toBe(1)
    expect(readdirSync(dir)).toEqual([]) // consumed
  })

  test('a malformed or incomplete file is skipped and deleted, never looping, and does not stop a good one', () => {
    drop('1.json', '{not json')
    drop('2.json', { topicId: '9', sessionId: 'x' }) // missing cwd/model/title
    drop('3.json', good({ topicId: '777' }))
    const bound = drainSeedRequests(dir, store, () => 1)
    expect(bound).toEqual(['777'])
    expect(Object.keys(store.registry)).toEqual(['777'])
    expect(readdirSync(dir)).toEqual([]) // all three removed, bad ones too
  })

  test('a missing directory returns empty and does not throw', () => {
    expect(drainSeedRequests(join(dir, 'nope'), store, () => 1)).toEqual([])
    expect(saves).toBe(0)
  })

  test('is idempotent: a second drain finds nothing and does not save again', () => {
    drop('1.json', good())
    drainSeedRequests(dir, store, () => 1)
    expect(saves).toBe(1)
    expect(drainSeedRequests(dir, store, () => 1)).toEqual([])
    expect(saves).toBe(1)
  })

  test('the last request for a topic wins (files drained in filename order)', () => {
    drop('1.json', good({ sessionId: 'old' }))
    drop('2.json', good({ sessionId: 'new' }))
    drainSeedRequests(dir, store, () => 1)
    expect(store.registry['555'].sessionId).toBe('new')
  })

  test('does not save when nothing was bound', () => {
    drop('1.json', '{bad')
    expect(drainSeedRequests(dir, store, () => 1)).toEqual([])
    expect(saves).toBe(0)
    expect(existsSync(join(dir, '1.json'))).toBe(false)
  })
})
