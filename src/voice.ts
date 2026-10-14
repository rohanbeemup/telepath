/**
 * Voice notes: run the configured transcriber (TRANSCRIBE_CMD, given the audio file as its one
 * argument) and turn its output into the words the user said. Every way this can fail is an
 * error with a reason the topic is shown; a voice note never just goes silent.
 */
import { spawn } from 'child_process'

export class VoiceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'VoiceError'
  }
}

/** The transcriber's output minus its `[lang=.. p=..]` tag; nothing heard is an error. Pure. */
export function parseTranscript(out: string): string {
  const words = out.trim().replace(/^\[lang=[^\]]*\]\s*/, '').trim()
  if (!words) throw new VoiceError('heard nothing in the voice note')
  return words
}

/** Transcribe one audio file. Async, so a slow transcription holds up nothing else. */
export async function transcribe(path: string, cmd: string | undefined, timeoutMs = 180_000): Promise<string> {
  if (!cmd) throw new VoiceError("voice notes need TRANSCRIBE_CMD in telepath's .env (a command that prints the words of the audio file it is given)")
  const out = await new Promise<string>((resolve, reject) => {
    // Its own process group, so a timeout ends everything it started: a wrapper script's own
    // children (python, ffmpeg) would otherwise outlive every kill of the script and pile up.
    const group = process.platform !== 'win32'
    const child = spawn(cmd, [path], { stdio: ['ignore', 'pipe', 'pipe'], detached: group, windowsHide: true })
    const stop = () => {
      try {
        if (group && child.pid) process.kill(-child.pid, 'SIGKILL')
        else if (child.pid) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
      } catch {
        child.kill('SIGKILL')
      }
    }
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', d => (stdout += d))
    child.stderr.on('data', d => (stderr += d))
    const timer = setTimeout(() => {
      stop()
      reject(new VoiceError(`transcription took longer than ${Math.round(timeoutMs / 1000)}s`))
    }, timeoutMs)
    child.on('error', e => {
      clearTimeout(timer)
      reject(new VoiceError(`could not run ${cmd}: ${e.message}`))
    })
    child.on('close', code => {
      clearTimeout(timer)
      if (code === 0) resolve(stdout)
      else reject(new VoiceError(`transcriber exited ${code}: ${stderr.trim().slice(-500) || 'no output'}`))
    })
  })
  return parseTranscript(out)
}

/** Keeps a topic's messages in the order they were sent while a voice note is being transcribed. */
export class TopicOrder {
  private chains = new Map<string, Promise<void>>()

  /** Run fn after everything already queued for this topic; returns at once. A failure is
   *  reported and the topic's queue carries on. */
  queue(key: string, fn: () => Promise<void>, onError: (e: unknown) => void): void {
    const next: Promise<void> = (this.chains.get(key) ?? Promise.resolve())
      .then(fn)
      .catch(onError)
      .finally(() => {
        if (this.chains.get(key) === next) this.chains.delete(key)
      })
    this.chains.set(key, next)
  }

  /** Something is still queued for this topic, so a new message must queue behind it. */
  busy(key: string): boolean {
    return this.chains.has(key)
  }
}
