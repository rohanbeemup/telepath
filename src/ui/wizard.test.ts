import { test, expect, describe } from 'bun:test'
import { startWizard, wizardStep } from './wizard'
import { buildCatalog } from '../models'

const catalog = buildCatalog({
  ids: { haiku: 'claude-haiku-4-5', sonnet: 'claude-sonnet-5', opus: 'claude-opus-5', fable: 'claude-fable-5-1' },
  enabled: ['haiku', 'sonnet', 'opus', 'fable'],
})
const folders = ['/repos/a', '/repos/b']

describe('wizard', () => {
  test('folder then model then effort then approvals for a model with effort levels', () => {
    let s = startWizard(folders)
    expect(s.step).toBe('folder')
    let r = wizardStep(s, { type: 'pickFolder', index: 1 }, catalog)
    expect(r.state.step).toBe('model')
    expect(r.state.cwd).toBe('/repos/b')
    r = wizardStep(r.state, { type: 'pickModel', key: 'fable' }, catalog)
    expect(r.state.step).toBe('effort')
    r = wizardStep(r.state, { type: 'pickEffort', effort: 'high' }, catalog)
    expect(r.state.step).toBe('auto')
    r = wizardStep(r.state, { type: 'pickAuto', auto: true }, catalog)
    expect(r.done).toEqual({ cwd: '/repos/b', model: 'claude-fable-5-1', effort: 'high', auto: true, bindTopic: undefined })
  })

  test('skips the effort step for a model without effort levels', () => {
    let r = wizardStep(startWizard(folders), { type: 'pickFolder', index: 0 }, catalog)
    r = wizardStep(r.state, { type: 'pickModel', key: 'haiku' }, catalog)
    expect(r.state.step).toBe('auto')
    r = wizardStep(r.state, { type: 'pickAuto', auto: false }, catalog)
    expect(r.done?.effort).toBeUndefined()
    expect(r.done?.model).toBe('claude-haiku-4-5')
  })

  test('back from the effort step returns to the model step keeping the folder', () => {
    let r = wizardStep(startWizard(folders, '77'), { type: 'pickFolder', index: 0 }, catalog)
    r = wizardStep(r.state, { type: 'pickModel', key: 'opus' }, catalog)
    r = wizardStep(r.state, { type: 'back' }, catalog)
    expect(r.state.step).toBe('model')
    expect(r.state.cwd).toBe('/repos/a')
    expect(r.state.bindTopic).toBe('77')
  })

  test('default effort in the wizard means the settings default', () => {
    let r = wizardStep(startWizard(folders), { type: 'pickFolder', index: 0 }, catalog)
    r = wizardStep(r.state, { type: 'pickModel', key: 'opus' }, catalog)
    r = wizardStep(r.state, { type: 'pickEffort', effort: 'default' }, catalog)
    r = wizardStep(r.state, { type: 'pickAuto', auto: false }, catalog)
    expect(r.done?.effort).toBeUndefined()
  })

  test('an unknown model key is refused and leaves the state unchanged', () => {
    const r0 = wizardStep(startWizard(folders), { type: 'pickFolder', index: 0 }, catalog)
    for (const key of ['constructor', 'unicorn', '']) {
      const r = wizardStep(r0.state, { type: 'pickModel', key }, catalog)
      expect(r.refused).toBeTruthy()
      expect(r.state).toEqual(r0.state)
    }
    // a known package the config disabled is refused too: the menus never offered it
    const partial = buildCatalog({ ...catalog, enabled: ['sonnet', 'opus'] })
    const off = wizardStep(r0.state, { type: 'pickModel', key: 'haiku' }, partial)
    expect(off.refused).toBeTruthy()
    expect(off.state).toEqual(r0.state)
    // an out-of-range folder index is refused the same way
    const bad = wizardStep(startWizard(folders), { type: 'pickFolder', index: 9 }, catalog)
    expect(bad.refused).toBeTruthy()
    expect(bad.state.step).toBe('folder')
    // approvals before a folder is chosen cannot finish
    const early = wizardStep(startWizard(folders), { type: 'pickAuto', auto: true }, catalog)
    expect(early.done).toBeUndefined()
    expect(early.refused).toBeTruthy()
  })
})
