import { test, expect, describe } from 'bun:test'
import {
  topicControlsKb,
  topicControlsText,
  settingsKb,
  pagedListKb,
  wizardModelKb,
  wizardEffortKb,
  wizardAutoKb,
  mainMenuKb,
  askKeyboard,
  approveKb,
  statusLiveKb,
  wrapConfirmKb,
  wrapConfirmText,
  resumeKb,
  callbackData,
  labels,
} from './keyboards'
import { buildCatalog } from '../models'
import type { Binding } from '../state'

const catalog = buildCatalog({
  ids: { haiku: 'claude-haiku-4-5', sonnet: 'claude-sonnet-5', opus: 'claude-opus-5', fable: 'claude-fable-5-1' },
  enabled: ['sonnet', 'opus', 'fable'],
})
const binding = (over: Partial<Binding> = {}): Binding => ({ cwd: 'C:/repo', model: 'claude-opus-5', title: 'repo', lastActive: 0, ...over })

describe('pinned controls', () => {
  test('pinned controls show only enabled models and mark the current one', () => {
    const l = labels(topicControlsKb(catalog, binding({ model: 'claude-opus-5' })))
    expect(l.some(x => x.includes('Haiku'))).toBe(false)
    expect(l).toContain('🧠 Opus ✓')
    expect(l).toContain('⚡ Sonnet')
    expect(l).toContain('✨ Fable')
  })

  test('effort rows appear only for models with effort levels', () => {
    const withEffort = labels(topicControlsKb(catalog, binding({ model: 'claude-opus-5', effort: 'high' })))
    expect(withEffort).toContain('🎚 high ✓')
    const haiku = buildCatalog({ ...catalog, enabled: ['haiku', 'opus'] })
    const none = labels(topicControlsKb(haiku, binding({ model: 'claude-haiku-4-5', effort: 'high' })))
    expect(none.some(x => x.startsWith('🎚'))).toBe(false)
    expect(topicControlsText(haiku, binding({ model: 'claude-haiku-4-5' }))).not.toContain('🎚')
  })

  test('the activity feed toggle reflects the effective default in auto and approvals', () => {
    expect(labels(topicControlsKb(catalog, binding({ auto: true })))).toContain('🔎 Activity feed: ON → hide tool calls')
    expect(labels(topicControlsKb(catalog, binding({ auto: false })))).toContain('🔎 Activity feed: OFF → show tool calls')
    expect(labels(topicControlsKb(catalog, binding({ auto: false, feed: true })))).toContain('🔎 Activity feed: ON → hide tool calls')
    expect(topicControlsText(catalog, binding({ auto: true }))).toContain('🔎 feed on')
  })
})

describe('wrap-up', () => {
  test('the wrap-up confirmation offers no drop and names the messages sent during the turn', () => {
    expect(labels(wrapConfirmKb()).some(l => /drop/i.test(l))).toBe(false)
    expect(labels(wrapConfirmKb())).toEqual(['⏹ Hand off at the next step (recommended)', '⏳ Finish this turn first, then hand off', '↩️ Cancel'])
    expect(wrapConfirmText(0)).not.toContain('already with the session')
    expect(wrapConfirmText(3)).toContain('The 3 messages you sent during this turn are already with the session')
    expect(wrapConfirmText(1)).toContain('The message you sent during this turn is already with the session')
    expect(labels(statusLiveKb())).toEqual(['⏹ Wrap up'])
    expect(labels(resumeKb())).toEqual(['▶️ Resume from hand-off'])
  })
})

describe('lists', () => {
  test('pages a long list two per row with prev and next only where they lead somewhere', () => {
    const buttons = Array.from({ length: 25 }, (_, i) => ({ label: `b${i}`, data: `m:x:${i}` }))
    const first = labels(pagedListKb(buttons, 0, 'pg'))
    expect(first).toContain('Next ▶️')
    expect(first).not.toContain('◀️ Prev')
    const last = labels(pagedListKb(buttons, 2, 'pg'))
    expect(last).toContain('◀️ Prev')
    expect(last).not.toContain('Next ▶️')
    const rows = pagedListKb(buttons, 0, 'pg').inline_keyboard
    expect(rows[0].length).toBe(2)
    expect(rows.slice(0, 5).every(r => r.length === 2)).toBe(true)
  })
})

describe('telegram limits', () => {
  test("callback data never exceeds telegram's 64-byte limit", () => {
    const wide = buildCatalog({
      ids: { haiku: 'x'.repeat(200), sonnet: 'y'.repeat(200), opus: 'z'.repeat(200), fable: 'w'.repeat(200) },
      enabled: ['haiku', 'sonnet', 'opus', 'fable'],
    })
    const kbs = [
      mainMenuKb(),
      settingsKb(wide, { defaultModel: 'x'.repeat(200), defaultCwd: '/', defaultEffort: 'max' }),
      topicControlsKb(wide, binding({ model: 'z'.repeat(200), effort: 'xhigh', auto: true })),
      wizardModelKb(wide),
      wizardEffortKb('high'),
      wizardAutoKb(),
      pagedListKb(Array.from({ length: 1000 }, (_, i) => ({ label: 'L'.repeat(300), data: `m:sess:${'f'.repeat(8)}` })), 99, 'spage'),
      askKeyboard('zz9', Array.from({ length: 30 }, (_, i) => ({ label: 'option '.repeat(20) + i })), true, new Set([1, 2])),
      approveKb('abc'),
      statusLiveKb(),
      wrapConfirmKb(),
      resumeKb(),
    ]
    for (const kb of kbs) {
      for (const data of callbackData(kb)) expect(Buffer.byteLength(data, 'utf8')).toBeLessThanOrEqual(64)
    }
  })
})
