/**
 * Model packages and effort levels.
 *
 * A "package" is a stable key (haiku, sonnet, opus, fable) the menus and typed commands
 * use; the model id behind it comes from configuration, so a user can pin an older
 * generation without the UI changing. Everything here is data and pure functions.
 */

export const MODEL_KEYS = ['haiku', 'sonnet', 'opus', 'fable'] as const
export type ModelKey = (typeof MODEL_KEYS)[number]

export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type Effort = (typeof EFFORT_LEVELS)[number]

/** Haiku 4.5 rejects an effort parameter; every other package accepts low…max. */
const EFFORT_MODELS: ReadonlySet<ModelKey> = new Set<ModelKey>(['sonnet', 'opus', 'fable'])

export const MODEL_MENU: Record<ModelKey, { short: string; long: string }> = {
  haiku: { short: '🐇 Haiku', long: '🐇 Haiku — cheapest & fastest, no effort levels' },
  sonnet: { short: '⚡ Sonnet', long: '⚡ Sonnet — fast & cheap' },
  opus: { short: '🧠 Opus', long: '🧠 Opus — strong all-rounder (~2.5× Sonnet)' },
  fable: { short: '✨ Fable', long: '✨ Fable — frontier, premium (~2× Opus)' },
}

export const EFFORT_MENU: Record<Effort, { short: string; long: string }> = {
  low: { short: 'low', long: '🎚 low — quick & cheap' },
  medium: { short: 'med', long: '🎚 medium — balanced' },
  high: { short: 'high', long: '🎚 high — deep reasoning' },
  xhigh: { short: 'xhigh', long: '🎚 xhigh — deeper, best for hard coding' },
  max: { short: 'max', long: '🎚 max — everything it has' },
}

export function parseEffort(s: string | undefined): Effort | undefined {
  const v = s?.trim().toLowerCase()
  return (EFFORT_LEVELS as readonly string[]).includes(v ?? '') ? (v as Effort) : undefined
}

export type Catalog = {
  /** model id per package key */
  ids: Record<ModelKey, string>
  /** packages the menus offer, in menu order; never empty */
  enabled: ModelKey[]
}

export function buildCatalog(input: { ids: Record<ModelKey, string>; enabled: string[] }): Catalog {
  const enabled = input.enabled.filter((k): k is ModelKey => (MODEL_KEYS as readonly string[]).includes(k))
  return { ids: { ...input.ids }, enabled: enabled.length ? enabled : ['sonnet'] }
}

/** Own-property check: callback data and typed text are user input. */
export function isModelKey(c: Catalog, k: string): k is ModelKey {
  return (MODEL_KEYS as readonly string[]).includes(k) && Object.hasOwn(c.ids, k)
}

export function modelKeyOf(c: Catalog, modelId: string): ModelKey | undefined {
  return MODEL_KEYS.find(k => c.ids[k] === modelId)
}

export function modelLabel(c: Catalog, modelId: string): string {
  const k = modelKeyOf(c, modelId)
  return k ? MODEL_MENU[k].short : modelId
}

export function supportsEffort(c: Catalog, modelId: string): boolean {
  const k = modelKeyOf(c, modelId)
  return !!k && EFFORT_MODELS.has(k)
}

/**
 * The effort a binding actually runs with: its own level, only where the model accepts
 * one. A topic switched to Haiku keeps its stored level for when it switches back.
 */
export function effortFor(c: Catalog, b: { model: string; effort?: Effort }): Effort | undefined {
  return supportsEffort(c, b.model) ? b.effort : undefined
}

/** Which id each enabled key resolves to, for the wizard and settings body text. */
export function modelLines(c: Catalog): string {
  return c.enabled.map(k => `${MODEL_MENU[k].short} → ${c.ids[k]}`).join('\n')
}
