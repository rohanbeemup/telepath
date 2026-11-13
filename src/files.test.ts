import { test, expect, describe } from 'bun:test'
import { chmodSync, mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import { projectsRoot, transcriptExists } from './files'

describe('transcripts on disk', () => {
  test('a transcript is looked for on disk, and not looking is not a no', () => {
    // the transcripts live where the CLI keeps them: CLAUDE_CONFIG_DIR when set, else ~/.claude
    expect(projectsRoot({ CLAUDE_CONFIG_DIR: '/srv/claude' })).toBe(join('/srv/claude', 'projects'))
    expect(projectsRoot({})).toBe(join(homedir(), '.claude', 'projects'))
    const dir = mkdtempSync(join(tmpdir(), 'telepath-projects-'))
    try {
      mkdirSync(join(dir, 'p1'))
      mkdirSync(join(dir, 'p2'))
      writeFileSync(join(dir, 'p1', 's1.jsonl'), '{}\n')
      expect(transcriptExists('s1', dir)).toBe(true) // in one project
      expect(transcriptExists('nope', dir)).toBe(false) // in none: a definite no
      // a stray file beside the projects (a .DS_Store) is no place to look: still a definite no
      writeFileSync(join(dir, '.DS_Store'), '')
      expect(transcriptExists('nope', dir)).toBe(false)
      // a project that cannot be looked into (a permission in the way) makes the answer unknown, not no
      mkdirSync(join(dir, 'p3'))
      chmodSync(join(dir, 'p3'), 0o000)
      if (process.getuid?.() !== 0) expect(transcriptExists('nope', dir)).toBeUndefined() // root looks past permissions
      chmodSync(join(dir, 'p3'), 0o700)
      expect(transcriptExists('s1', dir)).toBe(true) // found is found, whatever else could not be looked at
      // a projects directory that cannot be read at all is unknown too
      expect(transcriptExists('s1', join(dir, 'missing'))).toBeUndefined()
      // a project reached through a symlink is a project: its transcripts count
      const elsewhere = mkdtempSync(join(tmpdir(), 'telepath-linked-'))
      try {
        writeFileSync(join(elsewhere, 's2.jsonl'), '{}\n')
        symlinkSync(elsewhere, join(dir, 'linked'))
        expect(transcriptExists('s2', dir)).toBe(true)
        // a link to a file is not a project either: a definite no, not unknown
        symlinkSync(join(dir, '.DS_Store'), join(dir, 'linkfile'))
        expect(transcriptExists('nope', dir)).toBe(false)
      } finally {
        rmSync(elsewhere, { recursive: true, force: true })
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
