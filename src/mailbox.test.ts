import { test, expect, describe } from 'bun:test'
import { Mailbox, userMessage } from './mailbox'

describe('Mailbox', () => {
  test('delivers pushed messages in order to a single consumer', async () => {
    const m = new Mailbox<number>()
    m.push(1)
    m.push(2)
    m.push(3)
    const iter = m[Symbol.asyncIterator]()
    expect((await iter.next()).value).toBe(1)
    expect((await iter.next()).value).toBe(2)
    expect((await iter.next()).value).toBe(3)
  })

  test('waits for the next push instead of ending', async () => {
    const m = new Mailbox<string>()
    const iter = m[Symbol.asyncIterator]()
    let settled = false
    const pending = iter.next().then(r => {
      settled = true
      return r
    })
    await new Promise(r => setTimeout(r, 20))
    expect(settled).toBe(false)
    m.push('late')
    const r = await pending
    expect(r).toEqual({ value: 'late', done: false })
  })

  test('ends the iteration when closed and rejects pushes after close', async () => {
    const m = new Mailbox<string>()
    const iter = m[Symbol.asyncIterator]()
    const pending = iter.next()
    m.close()
    expect((await pending).done).toBe(true)
    expect((await iter.next()).done).toBe(true)
    expect(() => m.push('x')).toThrow()
    expect(m.closed).toBe(true)
  })

  test('drops queued items on close instead of draining them afterwards', async () => {
    const m = new Mailbox<string>()
    m.push('queued-before-close')
    m.close()
    const iter = m[Symbol.asyncIterator]()
    expect((await iter.next()).done).toBe(true)
  })
})

describe('userMessage', () => {
  test('wraps text as a user message with parent_tool_use_id null', () => {
    expect(userMessage('hi')).toEqual({ type: 'user', message: { role: 'user', content: 'hi' }, parent_tool_use_id: null })
    expect(userMessage('hi', 'abc').session_id).toBe('abc')
    expect(userMessage('hi', undefined, 'now').priority).toBe('now')
    expect('priority' in userMessage('hi')).toBe(false)
  })
})
