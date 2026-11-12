import { test, expect } from 'bun:test'
import { parseTeamNew, TopicQuota } from './team'

test('/new in team mode takes the rest of the line as the title and ignores cwd= and auto', () => {
  const at = new Date(2026, 10, 12, 9, 5)
  expect(parseTeamNew('pricing question cwd=/etc auto', { firstName: 'Ann' }, at)).toEqual({ title: 'pricing question cwd=/etc auto' })
  expect(parseTeamNew('  spaced   out  ', { firstName: 'Ann' }, at)).toEqual({ title: 'spaced out' })
  // an empty title falls back to the member's name and the time
  expect(parseTeamNew('   ', { firstName: 'Ann' }, at)).toEqual({ title: 'Ann · 09:05' })
  expect(parseTeamNew('', { username: 'ann_x' }, at)).toEqual({ title: 'ann_x · 09:05' })
  expect(parseTeamNew('', {}, at)).toEqual({ title: 'member · 09:05' })
})

test('a member may open only so many topics a day', () => {
  let t = Date.UTC(2026, 10, 13, 9, 0)
  const q = new TopicQuota(2, () => t)
  expect(q.take('a')).toBe(true)
  expect(q.take('a')).toBe(true)
  expect(q.take('a')).toBe(false) // the third of the day
  expect(q.take('b')).toBe(true) // another member's own count
  expect(q.take('b')).toBe(true)
  expect(q.take('b')).toBe(false)
  t = Date.UTC(2026, 10, 14, 0, 1) // the next day
  expect(q.take('a')).toBe(true)
  expect(q.take('a')).toBe(true)
  expect(q.take('a')).toBe(false)
})
