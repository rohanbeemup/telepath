/**
 * A push-based AsyncIterable. `query()` stays resident for as long as the prompt
 * iterable it was given has not ended, reading one user message per turn, so the
 * mailbox is what turns the one-shot query API into a session that lives for a topic.
 */

export class Mailbox<T> implements AsyncIterable<T> {
  private readonly queue: T[] = []
  private waiter: ((r: IteratorResult<T>) => void) | undefined
  private _closed = false

  get closed(): boolean {
    return this._closed
  }

  push(item: T): void {
    if (this._closed) throw new Error('mailbox is closed')
    if (this.waiter) {
      const w = this.waiter
      this.waiter = undefined
      w({ value: item, done: false })
      return
    }
    this.queue.push(item)
  }

  /** Ends the iteration: a pending or future next() resolves done; pushes throw. */
  close(): void {
    if (this._closed) return
    this._closed = true
    if (this.waiter) {
      const w = this.waiter
      this.waiter = undefined
      w({ value: undefined as unknown as T, done: true })
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.queue.length) return Promise.resolve({ value: this.queue.shift() as T, done: false })
        if (this._closed) return Promise.resolve({ value: undefined as unknown as T, done: true })
        return new Promise(resolve => {
          this.waiter = resolve
        })
      },
      return: (): Promise<IteratorResult<T>> => {
        this.close()
        return Promise.resolve({ value: undefined as unknown as T, done: true })
      },
    }
  }
}

/** The SDK's user-message shape, kept local so no test needs the SDK's types. */
export type UserMessage = {
  type: 'user'
  message: { role: 'user'; content: string }
  parent_tool_use_id: null
  session_id?: string
}

export function userMessage(text: string, sessionId?: string): UserMessage {
  const m: UserMessage = { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null }
  if (sessionId) m.session_id = sessionId
  return m
}
