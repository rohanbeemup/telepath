import { test, expect, describe } from 'bun:test'
import { admitted, isAdmin, allowedAction, promptTapAllowed, profileLocked, Membership, type AccessConfig } from './access'

const single: AccessConfig = { teamMode: false, allowedUserId: '1', forumChatId: '-100', adminUserIds: ['1'] }
const team: AccessConfig = { teamMode: true, allowedUserId: '1', forumChatId: '-100', adminUserIds: ['1', '9'] }

describe('who is admitted', () => {
  test('outside team mode only the allowed user in the forum is admitted', () => {
    expect(admitted(single, { fromId: '1', chatId: '-100' })).toBe(true)
    expect(admitted(single, { fromId: '2', chatId: '-100' })).toBe(false)
    expect(admitted(single, { fromId: '1', chatId: '-200' })).toBe(false)
    expect(admitted(single, { fromId: undefined, chatId: '-100' })).toBe(false)
  })

  test('in team mode every message in the forum chat is admitted', () => {
    for (const fromId of ['1', '2', '9', '424242']) expect(admitted(team, { fromId, chatId: '-100' })).toBe(true)
  })

  test('in team mode a message from any other chat is rejected', () => {
    expect(admitted(team, { fromId: '2', chatId: '2' })).toBe(false) // a member's DM to the bot
    expect(admitted(team, { fromId: '1', chatId: '1' })).toBe(false) // the admin's own DM
    expect(admitted(team, { fromId: '9', chatId: '-200' })).toBe(false) // another group, by an admin
    expect(admitted(team, { fromId: '2', chatId: undefined })).toBe(false)
  })
})

const MEMBER_OK = [
  'chat', '/new', '/help', '/menu', 'feed', 'wrap',
  'm:menu', 'm:new', 'm:newhere', 'm:help', 'm:ctl', 'm:cancel', 'm:noop',
  'm:tf', 'm:twrap', 'm:tw:now', 'm:tw:turn', 'm:tres',
]
const ADMIN_ONLY = [
  'm:tclose', 'm:treopen', 'm:tdelete', 'm:tdelyes', 'm:twipe', 'm:twipeyes',
  'm:tm:opus', 'm:te:high', 'm:ta',
  'm:settings', 'm:sdm:opus', 'm:sde:high', 'm:sdf', 'm:sdfp:1', 'm:sdfi:0',
  'm:list', 'm:sess:abcd1234', 'm:spage:1', 'm:resume', 'm:quick', 'm:fpage:1', 'm:nf:0',
  'm:status', '/status',
  '/attach', '/auto', '/list', 'use', 'effort',
  'm:future', '/anything', 'something-new',
]

describe('what a member may do', () => {
  test('members may chat, open topics, wrap up and toggle the feed', () => {
    for (const a of MEMBER_OK) expect([a, allowedAction(team, '2', a)]).toEqual([a, true])
  })

  test('everything else is admins only in team mode, unknown actions included', () => {
    for (const a of ADMIN_ONLY) {
      expect([a, allowedAction(team, '2', a)]).toEqual([a, false])
      expect([a, allowedAction(team, '9', a)]).toEqual([a, true]) // an admin from ADMIN_USER_IDS
      expect([a, allowedAction(team, '1', a)]).toEqual([a, true]) // the installing user
    }
    expect(isAdmin(team, '2')).toBe(false)
    expect(isAdmin(team, '9')).toBe(true)
    expect(isAdmin(team, undefined)).toBe(false)
  })

  test('outside team mode no action is admin-gated', () => {
    for (const a of [...MEMBER_OK, ...ADMIN_ONLY]) expect([a, allowedAction(single, '1', a)]).toEqual([a, true])
    // whatever the admin list holds: the two lists are independent concerns
    for (const a of ADMIN_ONLY) expect([a, allowedAction({ ...single, adminUserIds: ['7'] }, '1', a)]).toEqual([a, true])
  })

  test('with a profile, the model, effort and approval actions are locked whoever taps them', () => {
    for (const a of ['m:tm:opus', 'm:tm:haiku', 'm:te:high', 'm:te:auto', 'm:ta', '/auto', 'use', 'effort']) expect([a, profileLocked(a)]).toEqual([a, true])
    for (const a of ['chat', '/new', '/help', '/menu', '/status', 'feed', 'wrap', 'm:menu', 'm:new', 'm:quick', 'm:tf', 'm:tclose', 'm:tdelete', 'm:twipe', 'm:settings', 'm:sdm:opus', '/attach', 'm:future']) {
      expect([a, profileLocked(a)]).toEqual([a, false])
    }
  })

  test('a prompt tap is honoured only from its own topic, and an approval only by an admin in team mode', () => {
    // outside team mode: as before, every tap passes
    for (const kind of ['question', 'approval'] as const) {
      expect(promptTapAllowed(single, { fromId: '1', kind, sameTopic: true })).toBe(true)
      expect(promptTapAllowed(single, { fromId: '1', kind, sameTopic: false })).toBe(true)
    }
    // a question: anyone in the topic that asked, nobody from elsewhere
    expect(promptTapAllowed(team, { fromId: '2', kind: 'question', sameTopic: true })).toBe(true)
    expect(promptTapAllowed(team, { fromId: '9', kind: 'question', sameTopic: true })).toBe(true)
    expect(promptTapAllowed(team, { fromId: '2', kind: 'question', sameTopic: false })).toBe(false)
    expect(promptTapAllowed(team, { fromId: '9', kind: 'question', sameTopic: false })).toBe(false)
    // an approval: an admin, in the topic that asked
    expect(promptTapAllowed(team, { fromId: '9', kind: 'approval', sameTopic: true })).toBe(true)
    expect(promptTapAllowed(team, { fromId: '1', kind: 'approval', sameTopic: true })).toBe(true)
    expect(promptTapAllowed(team, { fromId: '2', kind: 'approval', sameTopic: true })).toBe(false)
    expect(promptTapAllowed(team, { fromId: '9', kind: 'approval', sameTopic: false })).toBe(false)
    expect(promptTapAllowed(team, { fromId: undefined, kind: 'approval', sameTopic: true })).toBe(false)
  })
})

describe('membership', () => {
  test('in team mode a sender is admitted only when the forum reports them as a member', async () => {
    const statuses: Record<string, { status: string; is_member?: boolean }> = {
      '1': { status: 'creator' },
      '2': { status: 'administrator' },
      '3': { status: 'member' },
      '4': { status: 'restricted', is_member: true },
      '5': { status: 'left' },
      '6': { status: 'kicked' },
      '7': { status: 'restricted', is_member: false },
      '8': { status: 'something_new' },
    }
    const m = new Membership(async id => statuses[id] ?? { status: 'left' })
    for (const id of ['1', '2', '3', '4']) expect([id, await m.isMember(id)]).toEqual([id, true])
    for (const id of ['5', '6', '7', '8', '9']) expect([id, await m.isMember(id)]).toEqual([id, false])
  })

  test('a membership answer is cached, a failure only briefly, and a change the forum reports clears it', async () => {
    let t = 0
    let calls = 0
    let answer: () => { status: string } = () => ({ status: 'member' })
    const m = new Membership(
      async () => {
        calls++
        return answer()
      },
      { ttlMs: 600_000, graceMs: 30_000, now: () => t },
    )
    expect(await m.isMember('1')).toBe(true)
    expect(await m.isMember('1')).toBe(true)
    expect(calls).toBe(1) // remembered
    t = 600_001
    expect(await m.isMember('1')).toBe(true)
    expect(calls).toBe(2) // asked again after the TTL
    // a negative answer is re-checked after the grace, not the full TTL
    answer = () => ({ status: 'left' })
    t = 700_000
    expect(await m.isMember('2')).toBe(false)
    expect(calls).toBe(3)
    t = 700_000 + 29_000
    expect(await m.isMember('2')).toBe(false)
    expect(calls).toBe(3)
    t = 700_000 + 31_000
    answer = () => ({ status: 'member' })
    expect(await m.isMember('2')).toBe(true)
    expect(calls).toBe(4)
    // a thrown lookup is a no, kept for the grace only, then asked again
    answer = () => {
      throw new Error('502')
    }
    t = 800_000
    expect(await m.isMember('3')).toBe(false)
    expect(calls).toBe(5)
    t = 800_000 + 29_000
    expect(await m.isMember('3')).toBe(false)
    expect(calls).toBe(5) // not one call per message
    t = 800_000 + 31_000
    answer = () => ({ status: 'member' })
    expect(await m.isMember('3')).toBe(true)
    expect(calls).toBe(6)
    // the forum reports a change: the cached yes is dropped and the next check asks again
    t = 800_000 + 32_000
    answer = () => ({ status: 'kicked' })
    m.forget('3')
    expect(await m.isMember('3')).toBe(false)
    expect(calls).toBe(7)
    // forgetting an id nobody cached is fine
    m.forget('nobody')
  })
})
