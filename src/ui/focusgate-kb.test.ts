import { test, expect, describe } from 'bun:test'
import { focusGateKb, wizardModelKb, callbackData } from './keyboards'
import { parseGateTap, type GateItem, type GateView } from './focusgate'
import { startWizard, wizardStep } from './wizard'
import { buildCatalog } from '../models'

const catalog = buildCatalog({
  ids: { haiku: 'claude-haiku-4-5', sonnet: 'claude-sonnet-5', opus: 'claude-opus-5', fable: 'claude-fable-5-1' },
  enabled: ['sonnet', 'opus', 'fable'],
})

describe('focus gate', () => {
  const gateItem = (num: number, over: Partial<GateItem> = {}): GateItem => ({
    num, id: `${String(num).padStart(8, '0')}-0000-4000-8000-000000000000`, title: `item ${num}`, source: 'vscode',
    topicId: null, cwd: '/w', idleMin: 60, waiting: false, state: 'open', resume: `cd /w && claude --resume ${num}`, ...over,
  })

  test('focusGateKb: items, then park-idle, start anyway, cancel', () => {
    const v: GateView = {
      gate: true, limit: 3, inFlight: 7, more: 2,
      items: [
        gateItem(1, { source: 'telepath', topicId: '55', resume: 'https://t.me/c/123/55', idleMin: 5 }),
        gateItem(2, { idleMin: 45 }),
        gateItem(3, { idleMin: 5 }),
        gateItem(4, { source: 'telepath', resume: '/attach 00000004 (its topic is gone)', idleMin: 120 }),
        gateItem(5), gateItem(6), gateItem(7),
      ],
    }
    const rows = focusGateKb('tok', v).inline_keyboard
    expect(rows.length).toBe(6)
    const data = (b: any) => ('callback_data' in b ? b.callback_data : undefined)
    expect((rows[0][0] as any).url).toBe('https://t.me/c/123/55')
    expect(rows[0][0].text.startsWith('▶️ #1')).toBe(true)
    expect(rows[0].map(data)).toEqual([undefined, 'm:fg:tok:p:0'])
    expect(rows[1].map(data)).toEqual(['m:fg:tok:r:1', 'm:fg:tok:p:1'])
    expect(rows[2].map(data)).toEqual(['m:fg:tok:p:2'])
    expect(rows[3].map(data)).toEqual(['m:fg:tok:r:3', 'm:fg:tok:p:3'])
    expect(rows[5].map(data)).toEqual(['m:fg:tok:pi', 'm:fg:tok:go', 'm:fg:tok:x'])
    expect(rows.flat().some(b => b.text.includes('#6'))).toBe(false)
    const taps = callbackData(focusGateKb('tok', v)).map(parseGateTap)
    expect(taps.every(t => t?.token === 'tok')).toBe(true)
    expect(taps.find(t => t?.action === 'resume')).toEqual({ token: 'tok', action: 'resume', index: 1 })
  })

  test('wizard model step Back keeps the topic binding', () => {
    const back = wizardModelKb(catalog).inline_keyboard.flat().find(b => b.text.includes('Back'))
    expect(back && 'callback_data' in back ? back.callback_data : undefined).toBe('m:nback')
    let s = startWizard(['/a', '/b'], '42')
    s = wizardStep(s, { type: 'pickFolder', index: 0 }, catalog).state
    expect(s.step).toBe('model')
    s = wizardStep(s, { type: 'back' }, catalog).state
    expect(s.step).toBe('folder')
    expect(s.bindTopic).toBe('42')
  })
})
