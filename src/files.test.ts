import { test, expect, describe } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { transcriptExists } from './files'

describe('transcripts on disk', () => {
  test('a transcript is looked for on disk, and not looking is not a no', () => {
    const dir = mkdtempSync(join(tmpdir(), 'telepath-projects-'))
    try {
      mkdirSync(join(dir, 'p1'))
      mkdirSync(join(dir, 'p2'))
      writeFileSync(join(dir, 'p1', 's1.jsonl'), '{}\n')
      expect(transcriptExists('s1', dir)).toBe(true) // in one project
      expect(transcriptExists('nope', dir)).toBe(false) // in none: a definite no
      // a project that cannot be looked into (a file where a directory should be) makes the answer unknown, not no
      writeFileSync(join(dir, 'p3'), '')
      expect(transcriptExists('nope', dir)).toBeUndefined()
      expect(transcriptExists('s1', dir)).toBe(true) // found is found, whatever else could not be looked at
      // a projects directory that cannot be read at all is unknown too
      expect(transcriptExists('s1', join(dir, 'missing'))).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
