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
| `a character split across output chunks arrives whole` | a multi-byte character (é, an emoji) whose bytes reach telepath in two chunks comes through intact | decoding each chunk on its own, which turns a split character into replacement marks |
| `topics do not wait for each other` | a slow note in one topic holds up no other topic | one queue for every topic |
| `TRANSCRIBE_CMD can carry arguments and quoted paths` | `python3 ~/t.py --fast` and `"C:\Program Files\…\python.exe" "C:\my scripts\t.py"` become their words, `~` the home folder | spawning the whole line as one path; quotes ignored, splitting a path with spaces; `~` left as is |
| `a forwarded note or an audio file is passed on as content, not as the user's turn` | a forwarded voice note or an audio file reaches the session framed as shared content (who forwarded it, the caption, the transcript in a block), never as the user's own words | passing every transcript as the user's typed turn, so a recording or someone else's note gives commands |

### Negative cases

| Case | Must not happen | Mutant it kills |
|---|---|---|
| `a transcript that starts with a slash is still text` | a transcript is never cut or rewritten beyond the tag (it goes on to the same parser as typed text) | trimming words or punctuation from the transcript |
| `the user's own voice note is their turn, as if typed` | the user's own note is framed, or its caption dropped (dictated commands such as `stop` must keep working) | framing every note as content; dropping the caption |

Widened 2026-10-14 after the Codex pre-commit review: running the transcription in the
background let a message typed right after a voice note overtake it, so the last two rows
keep a topic's messages in order while a note is pending.

Widened 2026-10-15 after the independent review: the stand-in transcribers are JS run by the
test runtime (the shell scripts failed on Windows); a forwarded note or an audio file is shared
content, not the user's turn (in an auto-mode topic its words would otherwise run tools); a
caption is kept; `TRANSCRIBE_CMD` may carry arguments; the transcriber's output is decoded as one
stream (also found by the Codex branch review).

## Out of scope

- **The wiring in `bot.ts`** has no unit tests, like the photo and document handlers beside it:
  `message:voice` and `message:audio` → download (now cut off after 2 minutes, for photos and files
  too) → `transcribe` → the user's own note through the typed-text path, a shared one straight to
  the session; a voice note in General is refused like a photo. Ring 2 covers it.
- **A restart during a transcription loses that note**, and anything queued behind it in its
  topic, without a message: the handler returns before the transcription ends, so Telegram counts
  the update as handled. Restarts are deliberate and rare; a typed message is unaffected.
- **Transcription quality** (faster-whisper's model choice). Without `TRANSCRIBE_CMD` a voice note
  gets a reply saying so, on any machine.

## Ring

Ring 1: the suite above, plus `bun run check`. Ring 2, on this machine with the service on this
branch: a voice note in a session topic shows `🎙️ <words>` and the session answers; two notes in
two topics are both answered (no freeze); an audio file is handled the same way.
