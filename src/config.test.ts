import { test, expect, describe } from 'bun:test'
import { parseEnvFile, parseConfig, ConfigError, mergeEnvFile } from './config'
import { join } from 'path'

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

describe('team mode', () => {
  test('team mode is off unless TEAM_MODE says so', () => {
    expect(parseConfig({ ...REQUIRED }, '/state').teamMode).toBe(false)
    for (const v of ['0', 'false', 'off', '']) expect(parseConfig({ ...REQUIRED, TEAM_MODE: v }, '/state').teamMode).toBe(false)
    for (const v of ['1', 'true', 'on', 'TRUE']) expect(parseConfig({ ...REQUIRED, TEAM_MODE: v, PROFILE_FILE: '/p.json' }, '/state').teamMode).toBe(true)
  })

  test('team mode refuses to start without PROFILE_FILE', () => {
    let err: unknown
    try {
      parseConfig({ ...REQUIRED, TEAM_MODE: '1' }, '/state')
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(ConfigError)
    expect(String((err as Error).message)).toContain('PROFILE_FILE')
    // a profile without team mode is fine: one user with a locked assistant
    expect(parseConfig({ ...REQUIRED, PROFILE_FILE: '/p.json' }, '/state').profileFile).toBe('/p.json')
    // a relative path is the state directory's
    expect(parseConfig({ ...REQUIRED, PROFILE_FILE: 'profile.json' }, '/state').profileFile).toBe(join('/state', 'profile.json'))
    expect(parseConfig({ ...REQUIRED }, '/state').profileFile).toBeUndefined()
  })

  test('admins are the allowed user plus ADMIN_USER_IDS', () => {
    expect(parseConfig({ ...REQUIRED }, '/state').adminUserIds).toEqual(['1'])
    expect(parseConfig({ ...REQUIRED, ADMIN_USER_IDS: ' 2, 3 ,1,,2 ' }, '/state').adminUserIds).toEqual(['1', '2', '3'])
    // each a numeric Telegram id: a space for a comma, a handle or a stray letter is a config problem that names it
    for (const bad of ['123 456', '@rohan', '12a']) {
      let err: unknown
      try {
        parseConfig({ ...REQUIRED, ADMIN_USER_IDS: bad }, '/state')
      } catch (e) {
        err = e
      }
      expect(err).toBeInstanceOf(ConfigError)
      expect(String((err as Error).message)).toContain('ADMIN_USER_IDS')
    }
  })
})

describe('the per-member topic cap', () => {
  test('the per-member topic cap defaults to twenty a day and must be positive', () => {
    expect(parseConfig({ ...REQUIRED }, '/state').teamTopicsPerDay).toBe(20)
    expect(parseConfig({ ...REQUIRED, TEAM_TOPICS_PER_DAY: '5' }, '/state').teamTopicsPerDay).toBe(5)
    expect(() => parseConfig({ ...REQUIRED, TEAM_TOPICS_PER_DAY: '0' }, '/state')).toThrow(ConfigError)
  })

  test('the stuck-turn bound defaults to ten minutes and must be positive', () => {
    expect(parseConfig(REQUIRED, '/state').stuckTurnMinutes).toBe(10)
    expect(parseConfig({ ...REQUIRED, STUCK_TURN_MINUTES: '30' }, '/state').stuckTurnMinutes).toBe(30)
    expect(() => parseConfig({ ...REQUIRED, STUCK_TURN_MINUTES: '0' }, '/state')).toThrow(ConfigError)
    expect(() => parseConfig({ ...REQUIRED, TEAM_TOPICS_PER_DAY: '-3' }, '/state')).toThrow(ConfigError)
  })
})
