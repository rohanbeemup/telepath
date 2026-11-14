import { test, expect, describe } from 'bun:test'
import { admitted, isAdmin, allowedAction, profileLocked, profileFreshOnly, promptTapAllowed, membershipRequired, lookupFailureVerdict, Membership, type AccessConfig, type ChatMemberLike } from './access'

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
    // a proxy sender: an anonymous admin (from = GroupAnonymousBot) or a linked channel (from = 777000)
    expect(admitted(team, { fromId: '1087968824', chatId: '-100', anonymous: true })).toBe(false)
    expect(admitted(team, { fromId: '1', chatId: '-100', anonymous: true })).toBe(false)
    expect(admitted(team, { fromId: '2', chatId: '-100', anonymous: false })).toBe(true)
  })
})

const MEMBER_OK = [
  'chat', '/new', '/help', '/menu', 'feed', 'wrap',
  'm:menu', 'm:new', 'm:newhere', 'm:help', 'm:ctl', 'm:cancel', 'm:noop',
  'm:tf', 'm:twrap', 'm:tw:turn', 'm:tres',
]
const ADMIN_ONLY = [
  'm:tw:now', // wrapping up "now" interrupts a colleague's step; after this turn is a member's
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
    for (const a of ['m:tm:opus', 'm:tm:haiku', 'm:te:high', 'm:te:auto', 'm:ta', '/auto']) expect([a, profileLocked(a)]).toEqual([a, true])
    // typed use/effort configure nothing under a profile: they go to the session as chat, so they are not locked
    for (const a of ['use', 'effort', 'chat', '/new', '/help', '/menu', '/status', 'feed', 'wrap', 'm:menu', 'm:new', 'm:quick', 'm:tf', 'm:tclose', 'm:tdelete', 'm:twipe', 'm:settings', 'm:sdm:opus', '/attach', 'm:future']) {
      expect([a, profileLocked(a)]).toEqual([a, false])
    }
    // the sibling set: actions that would bind an old transcript, refused under a profile at the same gates
    // the list of the host's transcripts too: every pick on it is refused, so the screen would be dead and its titles are not the forum's to read
    for (const a of ['/attach', 'm:resume', 'm:sess:abcd1234', '/list', 'm:list']) expect([a, profileFreshOnly(a)]).toEqual([a, true])
    for (const a of ['/new', 'm:new', 'm:quick', 'm:newhere', 'chat', 'm:tm:opus', 'm:future']) expect([a, profileFreshOnly(a)]).toEqual([a, false])
  })

})

describe('membership', () => {
  test('in team mode a sender is admitted only when the forum reports them as a member', async () => {
    const statuses: Record<string, ChatMemberLike> = {
      '1': { status: 'creator' },
      '2': { status: 'administrator' },
      '3': { status: 'member' },
      '4': { status: 'restricted', is_member: true },
      '5': { status: 'left' },
      '6': { status: 'kicked' },
      '7': { status: 'restricted', is_member: false },
      '8': { status: 'something_new' },
      '10': { status: 'restricted', is_member: true, can_send_messages: true },
      '11': { status: 'restricted', is_member: true, can_send_messages: false }, // muted: Telegram drops their messages, their taps still arrive
    }
    const m = new Membership(async id => statuses[id] ?? { status: 'left' })
    for (const id of ['1', '2', '3', '4', '10']) expect([id, await m.check(id)]).toEqual([id, 'member'])
    for (const id of ['5', '6', '7', '8', '9', '11']) expect([id, await m.check(id)]).toEqual([id, 'no'])
    // Telegram answers 400 "user not found" for an id the chat has never seen: a no, not a blip.
    // A 400 about the chat itself is a misconfiguration, not a stranger: unknown, like any other failure.
    expect(lookupFailureVerdict({ error_code: 400, description: 'Bad Request: user not found' })).toBe('no')
    expect(lookupFailureVerdict({ error_code: 400, description: 'Bad Request: PARTICIPANT_ID_INVALID' })).toBe('no')
    expect(lookupFailureVerdict({ error_code: 400, description: 'Bad Request: USER_ID_INVALID' })).toBe('no')
    expect(lookupFailureVerdict({ error_code: 400, description: 'Bad Request: chat not found' })).toBe('unknown')
    expect(lookupFailureVerdict({ error_code: 400, description: 'Bad Request: member list is inaccessible' })).toBe('unknown')
    expect(lookupFailureVerdict({ error_code: 400 })).toBe('unknown')
    expect(lookupFailureVerdict({ error_code: 429, description: 'Too Many Requests' })).toBe('unknown')
    expect(lookupFailureVerdict({ error_code: 502 })).toBe('unknown')
    expect(lookupFailureVerdict(new Error('timed out'))).toBe('unknown')
    expect(lookupFailureVerdict(undefined)).toBe('unknown')
    // an admin from the config is admitted without asking the forum; a member is asked; outside team mode nobody is
    expect(membershipRequired(team, '9')).toBe(false)
    expect(membershipRequired(team, '1')).toBe(false)
    expect(membershipRequired(team, '2')).toBe(true)
    expect(membershipRequired(team, undefined)).toBe(true)
    expect(membershipRequired(single, '2')).toBe(false)
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
    expect(await m.check('1')).toBe('member')
    expect(await m.check('1')).toBe('member')
    expect(calls).toBe(1) // remembered
    t = 600_001
    expect(await m.check('1')).toBe('member')
    expect(calls).toBe(2) // asked again after the TTL
    // a negative answer is re-checked after the grace, not the full TTL
    answer = () => ({ status: 'left' })
    t = 700_000
    expect(await m.check('2')).toBe('no')
    expect(calls).toBe(3)
    t = 700_000 + 29_000
    expect(await m.check('2')).toBe('no')
    expect(calls).toBe(3)
    t = 700_000 + 31_000
    answer = () => ({ status: 'member' })
    expect(await m.check('2')).toBe('member')
    expect(calls).toBe(4)
    // a thrown lookup is unknown (so not a member), kept for the grace only, then asked again;
    // the notice is due once per fresh unknown, on the same grace, never for a no
    answer = () => {
      throw new Error('502')
    }
    t = 800_000
    expect(await m.check('3')).toBe('unknown')
    expect(calls).toBe(5)
    expect(m.noticeDue('3')).toBe(true)
    expect(m.noticeDue('3')).toBe(false)
    t = 800_000 + 29_000
    expect(await m.check('3')).toBe('unknown') // remembered as unknown, not as a no
    expect(calls).toBe(5) // not one call per message
    expect(m.noticeDue('3')).toBe(false)
    expect(await m.check('2')).toBe('member')
    answer = () => ({ status: 'left' })
    expect(await m.check('5')).toBe('no')
    expect(m.noticeDue('5')).toBe(false)
    expect(calls).toBe(6)
    // a 400 from Telegram is a no, not an unknown, and gets no notice
    answer = () => {
      throw { error_code: 400, description: 'Bad Request: user not found' }
    }
    expect(await m.check('stranger')).toBe('no')
    expect(m.noticeDue('stranger')).toBe(false)
    calls = 5
    t = 800_000 + 31_000
    answer = () => {
      throw new Error('502 again')
    }
    expect(await m.check('3')).toBe('unknown')
    expect(calls).toBe(6)
    expect(m.noticeDue('3')).toBe(true) // a fresh unknown after the grace: due again
    answer = () => ({ status: 'member' })
    t = 800_000 + 62_000
    expect(await m.check('3')).toBe('member')
    // the forum reports a change: the cached yes is dropped and the next check asks again
    t = 800_000 + 63_000
    answer = () => ({ status: 'kicked' })
    m.forget('3')
    expect(await m.check('3')).toBe('no')
    expect(calls).toBe(8)
    // forgetting an id nobody cached is fine
    m.forget('nobody')
    // a burst from one sender shares one lookup
    answer = () => ({ status: 'member' })
    const before = calls
    const burst = await Promise.all([m.check('burst'), m.check('burst'), m.check('burst')])
    expect(burst).toEqual(['member', 'member', 'member'])
    expect(calls).toBe(before + 1)
    // a change the forum reports while a lookup is pending invalidates that lookup's answer:
    // the stale yes is reported to the call that asked, but not cached, so the next check asks again
    let release: (v: { status: string }) => void = () => {}
    let askedSlow = 0
    const slow = new Membership(
      async () => {
        askedSlow++
        return askedSlow === 1 ? await new Promise<{ status: string }>(resolve => (release = resolve)) : { status: 'kicked' }
      },
      { ttlMs: 600_000, graceMs: 30_000, now: () => t },
    )
    const pendingCheck = slow.check('leaving')
    slow.forget('leaving') // kicked while the lookup is in flight
    release({ status: 'member' }) // the stale answer arrives
    expect(await pendingCheck).toBe('member')
    expect(await slow.check('leaving')).toBe('no')
    expect(askedSlow).toBe(2)
    // two removals around two lookups: neither the orphaned first lookup nor the overtaken second may cache a yes
    const releases: ((v: { status: string }) => void)[] = []
    let dblCalls = 0
    const dbl = new Membership(
      () => {
        dblCalls++
        if (dblCalls <= 2) return new Promise<{ status: string }>(resolve => releases.push(resolve))
        return Promise.resolve({ status: 'kicked' })
      },
      { ttlMs: 600_000, graceMs: 30_000, now: () => t },
    )
    const first = dbl.check('u')
    dbl.forget('u')
    const second = dbl.check('u')
    releases[0]({ status: 'member' }) // the orphaned first answer
    expect(await first).toBe('member')
    dbl.forget('u') // removed again while the second lookup is pending
    releases[1]({ status: 'member' }) // the overtaken second answer
    expect(await second).toBe('member')
    expect(await dbl.check('u')).toBe('no') // nothing was cached: the truth is asked for again
    expect(dblCalls).toBe(3)
    // an orphaned lookup's late answer never overrides the lookup that replaced it, whatever order they settle in
    const answers: ((v: { status: string }) => void)[] = []
    let lateCalls = 0
    const late = new Membership(
      () => {
        lateCalls++
        return new Promise<{ status: string }>(resolve => answers.push(resolve))
      },
      { ttlMs: 600_000, graceMs: 30_000, now: () => t },
    )
    const stale = late.check('v')
    late.forget('v') // removed while the first lookup is pending
    const fresh = late.check('v')
    answers[0]({ status: 'member' }) // the orphan answers first, from before the removal
    expect(await stale).toBe('member')
    answers[1]({ status: 'kicked' }) // the replacement answers the truth
    expect(await fresh).toBe('no')
    expect(await late.check('v')).toBe('no') // and the truth is what was kept
    expect(lateCalls).toBe(2)
    // a lookup that throws before returning a promise is a failed lookup like any other
    const thrower = new Membership(
      () => {
        throw new Error('api client gone')
      },
      { ttlMs: 600_000, graceMs: 30_000, now: () => t },
    )
    expect(await thrower.check('x')).toBe('unknown')
    expect(thrower.size).toBe(1)
    // expired entries are swept once the cache passes its size, so strangers do not pile up
    const small = new Membership(async () => ({ status: 'left' }), { ttlMs: 600_000, graceMs: 30_000, now: () => t, maxEntries: 3 })
    for (const id of ['s1', 's2', 's3']) await small.check(id)
    expect(small.size).toBe(3)
    t += 31_000 // all three have expired
    await small.check('s4')
    expect(small.size).toBe(1)
    // when nothing has expired, the entry expiring soonest goes instead: a forum larger than the cache cannot grow it
    const full = new Membership(async () => ({ status: 'member' }), { ttlMs: 600_000, graceMs: 30_000, now: () => t, maxEntries: 3 })
    for (const id of ['f1', 'f2', 'f3', 'f4', 'f5']) await full.check(id)
    expect(full.size).toBe(3)
    // soonest, not first in: a member who was first to write outlives the strangers' graces
    let mixedCalls = 0
    const mixed = new Membership(
      async id => {
        mixedCalls++
        return { status: id === 'M' ? 'member' : 'left' }
      },
      { ttlMs: 600_000, graceMs: 30_000, now: () => t, maxEntries: 3 },
    )
    await mixed.check('M')
    await mixed.check('x1')
    await mixed.check('x2')
    t += 10_000 // nothing has expired
    await mixed.check('x3') // full: a stranger's grace goes, not the member's TTL
    expect(mixed.size).toBe(3)
    expect(await mixed.check('M')).toBe('member')
    expect(mixedCalls).toBe(4) // M was still cached
  })
})

describe('prompt taps', () => {
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
