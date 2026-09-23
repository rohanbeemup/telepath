import { test, expect, describe } from 'bun:test'
import { parseHandoff, resumePrompt, HANDOFF_MARKER, WRAP_UP_PROMPT } from './handoff'

describe('parseHandoff', () => {
  test('parses the hand-off block into done, open and resume', () => {
    const text = `Finishing the typecheck first.\n\n${HANDOFF_MARKER}\nDone: Next 16.3.5 upgrade on branch next16, typecheck green.\nOpen: build not yet run; lockfile changed but not committed.\nResume: In C:/Bots/jpmetamods on branch next16, run pnpm build; if green, commit "chore: next 16.3.5" and open the PR against main.`
    const h = parseHandoff(text)
    expect(h?.done).toBe('Next 16.3.5 upgrade on branch next16, typecheck green.')
    expect(h?.open).toBe('build not yet run; lockfile changed but not committed.')
    expect(h?.resume.startsWith('In C:/Bots/jpmetamods on branch next16')).toBe(true)
    expect(h?.text.startsWith(HANDOFF_MARKER)).toBe(true)
    // markdown bold around the labels and a multi-line Resume are fine
    const md = `${HANDOFF_MARKER}\n**Done:** a\n**Open:** b\n**Resume:** first line\nsecond line`
    expect(parseHandoff(md)?.resume).toBe('first line\nsecond line')
    expect(parseHandoff(md)?.done).toBe('a')
  })

  test('text without a resume paragraph is not a hand-off', () => {
    expect(parseHandoff('All done, nothing open.')).toBeUndefined()
    expect(parseHandoff(`${HANDOFF_MARKER}\nDone: x\nOpen: y`)).toBeUndefined()
  })

  test('the resume prompt carries the hand-off verbatim and the wrap-up prompt asks for that exact shape', () => {
    const h = parseHandoff(`${HANDOFF_MARKER}\nDone: a\nOpen: b\nResume: c`)!
    const p = resumePrompt(h)
    expect(p).toContain(HANDOFF_MARKER)
    expect(p).toContain('Resume: c')
    for (const label of ['Done:', 'Open:', 'Resume:', HANDOFF_MARKER, 'Finish only the step']) expect(WRAP_UP_PROMPT).toContain(label)
  })
})
