import { test, expect, describe } from 'bun:test'
import { parseEnvFile, parseConfig, ConfigError, mergeEnvFile } from './config'

const REQUIRED = { TELEGRAM_BOT_TOKEN: 't', ALLOWED_USER_ID: '1', FORUM_CHAT_ID: '-100' }

describe('env file', () => {
  test('parses KEY=value lines and ignores comments and blanks', () => {
    const text = ['# a comment', '', 'A=1', '  B = two words ', '#C=3', 'D=', 'not a line'].join('\n')
    expect(parseEnvFile(text)).toEqual({ A: '1', B: 'two words', D: '' })
  })

  test('does not overwrite a variable the shell already set', () => {
    const env: Record<string, string | undefined> = { A: 'shell' }
    mergeEnvFile(env, { A: 'file', B: 'file' })
    expect(env).toEqual({ A: 'shell', B: 'file' })
  })
})

describe('config', () => {
  test('reports every missing required setting at once, not just the first', () => {
    let err: unknown
    try {
      parseConfig({}, '/state')
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(ConfigError)
    const msg = String((err as Error).message)
    for (const k of Object.keys(REQUIRED)) expect(msg).toContain(k)
  })

  test('rejects an effort level it does not know', () => {
    expect(() => parseConfig({ ...REQUIRED, DEFAULT_EFFORT: 'turbo' }, '/state')).toThrow(ConfigError)
    expect(parseConfig({ ...REQUIRED, DEFAULT_EFFORT: 'HIGH' }, '/state').defaultEffort).toBe('high')
    expect(parseConfig({ ...REQUIRED }, '/state').defaultEffort).toBeUndefined()
  })

  test('applies defaults for optional settings', () => {
    const c = parseConfig({ ...REQUIRED }, '/state')
    expect(c.idleMinutes).toBe(15)
    expect(c.maxLiveSessions).toBe(3)
    expect(c.catalog.ids.fable).toBe('claude-fable-5-1')
    expect(c.catalog.enabled).toEqual(['sonnet', 'opus'])
    expect(c.logLevel).toBe('info')
    expect(c.stateDir).toBe('/state')
    expect(c.defaultModel).toBe(c.catalog.ids.sonnet)
  })

  test('keeps only enabled models it knows and never ends with none', () => {
    expect(parseConfig({ ...REQUIRED, ENABLED_MODELS: 'fable, unicorn' }, '/s').catalog.enabled).toEqual(['fable'])
    expect(parseConfig({ ...REQUIRED, ENABLED_MODELS: 'unicorn,,' }, '/s').catalog.enabled).toEqual(['sonnet'])
  })

  test('does not let a prototype name pass as a model key', () => {
    expect(parseConfig({ ...REQUIRED, ENABLED_MODELS: 'constructor,__proto__,opus' }, '/s').catalog.enabled).toEqual(['opus'])
  })

  test('falls back to the first enabled model when the default is disabled', () => {
    const c = parseConfig({ ...REQUIRED, ENABLED_MODELS: 'opus,fable', DEFAULT_MODEL: 'claude-sonnet-5' }, '/s')
    expect(c.defaultModel).toBe('claude-opus-5')
  })
})
