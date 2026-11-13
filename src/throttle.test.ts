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
    // a flood of keys does not grow it without bound: once large, entries past their window go
    const wide = new Throttle(60_000, () => t)
    for (let i = 0; i < 1500; i++) wide.allow(`k${i}`)
    expect(wide.size).toBe(1500)
    t += 60_000
    wide.allow('fresh')
    expect(wide.size).toBe(1)
  })
})
