---
feature: A voice note sent in a topic is transcribed and handled as if it were typed, and when it cannot be, the topic says why instead of going silent
suite:
  - src/voice.test.ts
gate: bun test src/voice.test.ts
---

# Voice notes

## Premise

**The request.** Voice notes sent to topics used to be transcribed and acted on; since the
2026-10-14 cutover to telepath, nothing happens.

**Checked, 2026-10-14:**

- **Confirmed: no handler.** `src/bot.ts` wires `message:text`, `message:photo`,
  `message:document` and `callback_query:data` only, so grammY drops a voice update without a
  trace. No branch on origin has one.
- **Confirmed: the old fork had one.** `~/.claude/telegram-multiplex/daemon.ts` (the hand-copied
  fork the service ran before the cutover) handled `message:voice`: download, run
  `~/.claude/scripts/transcribe-voice.py <file>`, strip its `[lang=.. p=..]` tag, post
  `🎙️ <transcript>` and pass the text on as if typed. The cutover notes listed the Assistant
  Brief as the feature lost, not this one.
- **Confirmed: the transcriber still works.** faster-whisper "small" ran on a 2 s test clip,
  23 s cold. The old handler ran it with `execFileSync`, which froze every topic for that long.

## Cases

| Case | Asserts | Mutant it kills |
|---|---|---|
| `strips the language tag and returns the words` | `[lang=nl p=0.97] zet de build aan` comes back as `zet de build aan` | passing the raw output, tag included |
| `an empty transcript is an error, not an empty message` | output that is only the tag, or blank, is an error ("heard nothing") | sending an empty or tag-only message to the session |
| `without TRANSCRIBE_CMD the note is refused with the reason` | no command configured is an error that names `TRANSCRIBE_CMD` | returning quietly (today: nothing happens) |
| `a failing or hung transcriber errors within the timeout` | a non-zero exit errors with its stderr; a command that never ends errors at the timeout, and nothing it started is left running | no timeout, so one stuck transcription hangs its topic; killing only the transcriber, so a wrapper's own children (python, ffmpeg) outlive every timeout; ignoring the exit code (a crashed transcriber reads as "heard nothing") |
| `TRANSCRIBE_CMD is read from the environment` | the config carries `TRANSCRIBE_CMD`, unset when absent | ignoring the setting |
| `a message sent after a voice note waits for its transcript` | while a topic's voice note is being transcribed, what is sent after it in that topic is handled after it, in order, even past a failure | handling the later message at once (it overtakes the note); a failure that stops the topic's queue |
| `topics do not wait for each other` | a slow note in one topic holds up no other topic | one queue for every topic |

### Negative cases

| Case | Must not happen | Mutant it kills |
|---|---|---|
| `a transcript that starts with a slash is still text` | a transcript is never cut or rewritten beyond the tag (it goes on to the same parser as typed text) | trimming words or punctuation from the transcript |

Widened 2026-10-14 after the Codex pre-commit review: running the transcription in the
background let a message typed right after a voice note overtake it, so the last two rows
keep a topic's messages in order while a note is pending.

## Out of scope

- **The wiring in `bot.ts`** (`message:voice` and `message:audio` → download → `transcribe` →
  `🎙️ <words>` → the typed-text path) has no unit tests, like the photo and document handlers
  beside it. Ring 2 covers it.
- **Transcription quality** (faster-whisper's model choice) and Windows: without
  `TRANSCRIBE_CMD` a voice note gets a reply saying so, on any machine.

## Ring

Ring 1: the suite above, plus `bun run check`. Ring 2, on this machine with the service on this
branch: a voice note in a session topic shows `🎙️ <words>` and the session answers; two notes in
two topics are both answered (no freeze); an audio file is handled the same way.
