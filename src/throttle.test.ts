import { test, expect, describe } from 'bun:test'
import { Throttle } from './throttle'

describe('refusal throttle', () => {
  test('a refusal is said at most once a minute per key', () => {
    let t = 0
    const th = new Throttle(60_000, () => t)
    expect(th.allow('a')).toBe(true)
    expect(th.allow('a')).toBe(false) // within the minute: muted
    expect(th.allow('b')).toBe(true) // another key has its own minute
    t += 59_999
    expect(th.allow('a')).toBe(false)
    t += 1
    expect(th.allow('a')).toBe(true) // a minute on: said again
    // a wider allowance: so many a window, then muted until the window turns
    const ten = new Throttle(60_000, () => t, 10)
    for (let i = 0; i < 10; i++) expect([i, ten.allow('member')]).toEqual([i, true])
    expect(ten.allow('member')).toBe(false)
    expect(ten.allow('other')).toBe(true)
    t += 60_000
    expect(ten.allow('member')).toBe(true)
    // peek asks without recording, so two throttles can be checked before either is charged
    const quiet = new Throttle(60_000, () => t)
    expect(quiet.peek('k')).toBe(true)
    expect(quiet.peek('k')).toBe(true) // nothing recorded
    expect(quiet.allow('k')).toBe(true)
    expect(quiet.peek('k')).toBe(false)
    t += 60_000
    expect(quiet.peek('k')).toBe(true)
    // a flood of keys does not grow it without bound: once large, entries past their window go
    const wide = new Throttle(60_000, () => t)
    for (let i = 0; i < 1500; i++) wide.allow(`k${i}`)
    expect(wide.size).toBe(1500)
    t += 60_000
    wide.allow('fresh')
    expect(wide.size).toBe(1)
    // and the sweep runs at most once a window, so a large map is not walked on every call
    const busy = new Throttle(60_000, () => t)
    for (let i = 0; i < 900; i++) busy.allow(`p${i}`)
    t += 30_000
    for (let i = 0; i < 200; i++) busy.allow(`q${i}`) // crosses the mark: swept now (nothing has expired yet), and the time noted
    expect(busy.size).toBe(1100)
    t += 31_000
    busy.allow('y') // the p-keys have expired, but the last sweep was half a window ago: not walked
    expect(busy.size).toBe(1101)
    t += 30_000
    busy.allow('z') // a window since the last sweep: swept, and only y and z are inside theirs
    expect(busy.size).toBe(2)
  })
})
