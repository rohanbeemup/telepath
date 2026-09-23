import { test, expect, describe } from 'bun:test'
import { parseTyped } from './commands'
import { buildCatalog } from './models'

const catalog = buildCatalog({
  ids: { haiku: 'claude-haiku-4-5', sonnet: 'claude-sonnet-5', opus: 'claude-opus-5', fable: 'claude-fable-5-1' },
  enabled: ['sonnet', 'opus', 'fable'],
})

describe('parseTyped', () => {
  test('use with a model and optional effort', () => {
    expect(parseTyped('use fable high', catalog)).toEqual({ kind: 'use', model: 'fable', effort: 'high' })
    expect(parseTyped('USE opus', catalog)).toEqual({ kind: 'use', model: 'opus', effort: undefined })
    // a second word that is not an effort level is not a command
    expect(parseTyped('use opus please', catalog).kind).toBe('chat')
  })

  test('effort default clears', () => {
    expect(parseTyped('effort default', catalog)).toEqual({ kind: 'effort', effort: undefined })
    expect(parseTyped('effort MAX', catalog)).toEqual({ kind: 'effort', effort: 'max' })
    expect(parseTyped('effort turbo', catalog).kind).toBe('chat')
  })

  test('feed on and off', () => {
    expect(parseTyped('feed on', catalog)).toEqual({ kind: 'feed', on: true })
    expect(parseTyped('Feed OFF', catalog)).toEqual({ kind: 'feed', on: false })
  })

  test('wrap up and stop are commands', () => {
    expect(parseTyped('wrap up', catalog)).toEqual({ kind: 'wrap' })
    expect(parseTyped('Wrapup', catalog)).toEqual({ kind: 'wrap' })
    expect(parseTyped('STOP', catalog)).toEqual({ kind: 'wrap' })
    expect(parseTyped('stop the server please', catalog).kind).toBe('chat')
  })

  test('slash commands with args', () => {
    expect(parseTyped('/new my project cwd=/p auto', catalog)).toEqual({ kind: 'slash', cmd: 'new', args: 'my project cwd=/p auto' })
    expect(parseTyped('/menu', catalog)).toEqual({ kind: 'slash', cmd: 'menu', args: '' })
  })

  test('prototype names are not commands', () => {
    expect(parseTyped('use constructor', catalog).kind).toBe('chat')
    expect(parseTyped('use __proto__ high', catalog).kind).toBe('chat')
    // a real key the config disabled is still a key (the handler reports it), but an unknown word is chat
    expect(parseTyped('use haiku', catalog)).toEqual({ kind: 'use', model: 'haiku', effort: undefined })
  })

  test('plain text is chat', () => {
    expect(parseTyped('please use the opus approach here', catalog)).toEqual({ kind: 'chat', text: 'please use the opus approach here' })
    expect(parseTyped('  hello ', catalog)).toEqual({ kind: 'chat', text: 'hello' })
  })
})
