/**
 * Wrapping up a running turn without losing the thread.
 *
 * A hard interrupt drops whatever the model was in the middle of and leaves the user to
 * reconstruct where it stood. The wrap-up instead injects an instruction ahead of
 * everything queued: finish the step you are on, start nothing new, write a hand-off in a
 * fixed shape, stop. The hand-off's Resume paragraph is stored and offered as a button,
 * so the next turn (or a fresh session) continues exactly from there.
 *
 * Measured against SDK 0.3.278: a user message with `priority: 'now'` is delivered at the
 * next step boundary of the running turn (the turn ends with its own result, then the
 * message runs), `'next'` runs right after the current turn, and both run before any
 * message queued without a priority. So "hand off at the next step" is `now`, "finish
 * this turn first" is `next`, and neither has to wait behind five queued messages.
 */

export const HANDOFF_MARKER = '📋 Handoff'

export const WRAP_UP_PROMPT =
  `<telepath>\nThe user pressed Wrap up. Finish only the step you are in the middle of (if it was cut off, say so), ` +
  `start nothing new, then write a hand-off in exactly this shape and stop:\n\n` +
  `${HANDOFF_MARKER}\n` +
  `Done: what is finished and verified, in one or two lines\n` +
  `Open: what is not finished, including anything half-applied on disk\n` +
  `Resume: one self-contained paragraph a fresh session can paste to continue exactly from here (repo, branch, files, next command)\n` +
  `</telepath>`

export type Handoff = { done: string; open: string; resume: string; text: string }

/** The hand-off block in the model's text, or undefined when there is none worth resuming from. */
export function parseHandoff(text: string): Handoff | undefined {
  const start = text.indexOf(HANDOFF_MARKER)
  const block = (start >= 0 ? text.slice(start + HANDOFF_MARKER.length) : text).trim()
  const grab = (label: string, next: string[]): string => {
    // Markdown bold may wrap the label with or without its colon: `**Done:** a` and `**Done**: a`.
    const re = new RegExp(`(?:^|\\n)\\s*\\**${label}\\**\\s*:\\**\\s*([\\s\\S]*?)(?=\\n\\s*\\**(?:${next.join('|')})\\**\\s*:|$)`, 'i')
    const m = re.exec(block)
    return m ? m[1].trim() : ''
  }
  const done = grab('Done', ['Open', 'Resume'])
  const open = grab('Open', ['Resume', 'Done'])
  const resume = grab('Resume', ['Done', 'Open'])
  if (!resume) return undefined
  return { done, open, resume, text: start >= 0 ? text.slice(start).trim() : block }
}

/** What the next turn receives when the user taps Resume. */
export function resumePrompt(h: Handoff): string {
  return `Continue from this hand-off you wrote earlier. Do not repeat what is done; pick up at Open and Resume.\n\n${h.text}`
}
