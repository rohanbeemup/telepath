import { test, expect, describe, afterAll } from 'bun:test'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { parseTranscript, transcribe, TopicOrder, VoiceError } from './voice'
import { parseConfig } from './config'

const REQUIRED = { TELEGRAM_BOT_TOKEN: 't', ALLOWED_USER_ID: '1', FORUM_CHAT_ID: '-100' }

// Stand-in transcribers: each is a script that receives the audio path as its one argument.
const dir = mkdtempSync(join(tmpdir(), 'telepath-voice-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
function script(name: string, body: string): string {
  const p = join(dir, name)
  writeFileSync(p, `#!/bin/sh\n${body}\n`)
  chmodSync(p, 0o755)
  return p
}

describe('voice notes', () => {
  test('strips the language tag and returns the words', async () => {
    expect(parseTranscript('[lang=nl p=0.97] zet de build aan\n')).toBe('zet de build aan')
    const ok = script('ok.sh', 'echo "[lang=en p=0.91] heard: $1"')
    expect(await transcribe('/tmp/note.ogg', ok)).toBe('heard: /tmp/note.ogg')
  })

  test('an empty transcript is an error, not an empty message', () => {
    for (const out of ['[lang=en p=0.34] ', '', '\n  \n']) {
      expect(() => parseTranscript(out)).toThrow(VoiceError)
      expect(() => parseTranscript(out)).toThrow(/heard nothing/)
    }
  })

  test('without TRANSCRIBE_CMD the note is refused with the reason', async () => {
    await expect(transcribe('/tmp/note.ogg', undefined)).rejects.toThrow(/TRANSCRIBE_CMD/)
  })

  test('a failing or hung transcriber errors within the timeout', async () => {
    const failing = script('failing.sh', 'echo "model file missing" >&2; exit 3')
    await expect(transcribe('/tmp/note.ogg', failing)).rejects.toThrow(/model file missing/)
    // a wrapper script that starts its own child (as a python or ffmpeg step would) and hangs
    const pidFile = join(dir, 'child.pid')
    const hung = script('hung.sh', `sleep 30 & echo $! > ${pidFile}; wait`)
    const start = Date.now()
    await expect(transcribe('/tmp/note.ogg', hung, 300)).rejects.toThrow(/took longer than/)
    expect(Date.now() - start).toBeLessThan(3000)
    const child = Number(readFileSync(pidFile, 'utf8'))
    const alive = () => { try { process.kill(child, 0); return true } catch { return false } }
    for (let i = 0; i < 20 && alive(); i++) await new Promise(r => setTimeout(r, 50))
    expect(alive()).toBe(false)                       // nothing it started is left running
    await expect(transcribe('/tmp/note.ogg', join(dir, 'missing.sh'))).rejects.toThrow(VoiceError)
  })

  test('TRANSCRIBE_CMD is read from the environment', () => {
    expect(parseConfig({ ...REQUIRED, TRANSCRIBE_CMD: '/opt/whisper/transcribe' }, '/state').transcribeCmd).toBe('/opt/whisper/transcribe')
    expect(parseConfig(REQUIRED, '/state').transcribeCmd).toBeUndefined()
  })

  test('a message sent after a voice note waits for its transcript', async () => {
    const order = new TopicOrder()
    const seen: string[] = []
    const errors: unknown[] = []
    const wait = (ms: number) => new Promise(r => setTimeout(r, ms))
    order.queue('7', async () => { await wait(60); seen.push('voice') }, e => errors.push(e))
    expect(order.busy('7')).toBe(true)
    order.queue('7', async () => { throw new Error('boom') }, e => errors.push(e))
    order.queue('7', async () => { seen.push('text') }, e => errors.push(e))
    await wait(150)
    expect(seen).toEqual(['voice', 'text'])          // in the order sent, past a failure
    expect(errors.length).toBe(1)
    expect(order.busy('7')).toBe(false)
  })

  test('topics do not wait for each other', async () => {
    const order = new TopicOrder()
    const seen: string[] = []
    const wait = (ms: number) => new Promise(r => setTimeout(r, ms))
    order.queue('7', async () => { await wait(80); seen.push('slow topic') }, () => {})
    order.queue('9', async () => { seen.push('other topic') }, () => {})
    await wait(150)
    expect(seen).toEqual(['other topic', 'slow topic'])
  })

  test('a transcript that starts with a slash is still text', () => {
    expect(parseTranscript('[lang=en p=0.88] /new Debug assist, please.  ')).toBe('/new Debug assist, please.')
  })
})
