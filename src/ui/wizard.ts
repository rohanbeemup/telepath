/**
 * The new-session wizard as a state machine: folder → model → effort → approvals.
 * Pure transitions; the bot renders each step and feeds taps back in as actions, so
 * the order, the skipped step for Haiku and every refusal are tested without Telegram.
 */
import { isEnabledModelKey, isModelKey, parseEffort, supportsEffort, type Catalog, type Effort } from '../models'

export type WizardState = {
  step: 'folder' | 'model' | 'effort' | 'auto'
  folders: string[]
  cwd?: string
  model?: string
  effort?: Effort
  /** Set when the wizard runs inside an existing topic ("start a session here"). */
  bindTopic?: string
}

export type WizardAction =
  | { type: 'pickFolder'; index: number }
  | { type: 'pickModel'; key: string }
  | { type: 'pickEffort'; effort: Effort | 'default' }
  | { type: 'back' }
  | { type: 'pickAuto'; auto: boolean }

export type WizardDone = { cwd: string; model: string; effort: Effort | undefined; auto: boolean; bindTopic: string | undefined }

export type WizardResult = { state: WizardState; done?: WizardDone; refused?: string }

export function startWizard(folders: string[], bindTopic?: string): WizardState {
  return { step: 'folder', folders, bindTopic }
}

export function wizardStep(s: WizardState, a: WizardAction, catalog: Catalog): WizardResult {
  switch (a.type) {
    case 'pickFolder': {
      const cwd = s.folders[a.index]
      if (!Number.isInteger(a.index) || cwd === undefined) return { state: s, refused: 'unknown folder' }
      return { state: { ...s, step: 'model', cwd } }
    }
    case 'pickModel': {
      if (s.step !== 'model' && s.step !== 'effort' && s.step !== 'auto') return { state: s, refused: 'pick a folder first' }
      if (!isEnabledModelKey(catalog, a.key)) return { state: s, refused: isModelKey(catalog, a.key) ? 'that model is not enabled' : 'unknown model' }
      const model = catalog.ids[a.key]
      return { state: { ...s, model, effort: undefined, step: supportsEffort(catalog, model) ? 'effort' : 'auto' } }
    }
    case 'pickEffort': {
      if (s.step !== 'effort') return { state: s, refused: 'not at the effort step' }
      // "default" leaves the choice unset; the caller applies the Settings default.
      const effort = a.effort === 'default' ? undefined : parseEffort(a.effort)
      if (a.effort !== 'default' && !effort) return { state: s, refused: 'unknown effort' }
      return { state: { ...s, effort, step: 'auto' } }
    }
    case 'back': {
      if (s.step === 'effort' || s.step === 'auto') return { state: { ...s, step: 'model', effort: undefined } }
      return { state: { ...s, step: 'folder' } }
    }
    case 'pickAuto': {
      if (s.step !== 'auto' || !s.cwd) return { state: s, refused: 'not ready to finish' }
      return {
        state: s,
        done: { cwd: s.cwd, model: s.model ?? catalog.ids[catalog.enabled[0]], effort: s.effort, auto: a.auto, bindTopic: s.bindTopic },
      }
    }
  }
}
