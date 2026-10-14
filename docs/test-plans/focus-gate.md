---
feature: Starting a new topic while three or more work items are already in flight asks once first (resume one, park one, or start anyway); a reply in one topic never evicts a session that is mid-turn in another
suite:
  - src/focus.test.ts
  - src/ui/focusgate.test.ts
  - src/ui/focusgate-kb.test.ts
gate: bun test src/focus.test.ts src/ui/focusgate.test.ts src/ui/focusgate-kb.test.ts
---

# Focus gate on new topics

Sign-off: plan approval 2026-10-14 (Rohan, plan "Focus: a work-item tracker with a 3-item
soft limit", which carried these case tables).

## Premise

The request: Rohan starts too many threads and forgets to return to them; a soft limit of
three should make a new one ask first. The item logic lives in an external tool
(`~/.claude/scripts/focus/focus.py`, its own suite); telepath only asks it and displays the
answer, the way it hands rate-limit events to the account rotator.

Checked on 2026-10-14 against this branch:

- **Still true:** four paths create a new session: typed `/new` (`handleText`), ⚡ `m:quick`,
  🆕 `m:new` and `m:newhere` (`handleMenu`). `/attach`, ▶️ `m:resume` and `m:sess:` reopen an
  existing session, which is resuming an item, not starting one, so they are not gated.
- **False: "gating `m:new` is enough".** The wizard's model step Back button sends `m:new`
  (`wizardModelKb`), so a gate there asks again on every Back, and it restarts the wizard
  without `bindTopic`, so "Start a session here" followed by Back creates a new topic
  instead of binding the current one. Replaced by sending `m:nback`, which the wizard
  already maps to the folder step with its state kept.
- **False: "the session cap only ever closes idle sessions".** `enforceCap` closes the least
  recently active session whether or not a turn is running, and the existing case
  `evicts the least recently active session when the cap is reached and tells that topic`
  pins exactly that: both older sessions are mid-turn when the third arrives. With a Focus
  topic answering replies, that kills a running turn in another topic. Replaced by: evict
  the oldest idle session; when every live session is busy, run over the cap and count it.
- **Still true:** a new topic has no Claude session id until its first turn, so telepath
  cannot register the item itself; the external tool finds it in the transcript.
- **Still true:** `bot.ts` has no tests by this repo's own rule (`query-api-rewrite.md`,
  Out of scope); every decision here is in `src/ui/focusgate.ts` and `src/focus.ts`.

## Cases

| Case | Asserts | Mutant it kills |
|---|---|---|
| `focusEnabled: off by env or missing CLI` | `FOCUS_GATE=off`, or `FOCUS_CLI` at a missing file, is off; an existing file is on | no `existsSync`: every `/new` spawns a missing script |
| `focus gate: parses the CLI JSON and rejects junk` | a valid view parses with its items; truncated JSON, a non-object, `items` not an array, or an item without a number gives no view; an `error` or `reason` the tool reports is kept, so telepath can log a gate the tool itself could not compute | trusting the shape: malformed output throws inside `/new`; dropping the tool's error, so a broken tool reads as "under the limit" |
| `focus gate: resume opens the holding topic, refuses a recently written session, else attaches` | decided at tap time: a session a topic already holds opens that topic; a transcript written to in the last 30 minutes is not attached (it is still live elsewhere); a session that cannot be found is reported; otherwise it is attached | attaching on the snapshot's idle time, which counts from the last prompt, so one transcript gets two writers |
| `focus gate: only new-session entry points are gated` | `new`, `quick`, `wizard`, `newhere` are gated; `attach`, `resume`, `sess` are not | gating attach, which gates the gate's own Resume |
| `focus gate: start anyway creates with the held parameters` | a `go` tap creates exactly what was held (kind, name, cwd, model, effort, auto, topic) | creating with defaults after the prompt |
| `focus gate: park marks then creates, even when the mark fails` | a park tap marks that item's number parked, then creates; a failed mark still creates and posts a notice; park-idle does the same with `park-idle` | aborting on a failed mark, so the held creation is lost |
| `focus gate: an expired or unknown token says send /new again` | tokens are random; a tap after the expiry, or with an unknown token, creates nothing and says to send `/new` again; a token is used once | counter tokens reused after a restart park the wrong item |
| `focusGateKb: items, then park-idle, start anyway, cancel` | at most five item rows; a telepath item resumes by its topic link; another resumes by an attach callback only when idle over 30 minutes; every item has Park; the last row is park-idle, start anyway, cancel | a callback for every item; attaching a VS Code session that is still live |
| `wizard model step Back keeps the topic binding` | the model step's Back sends `m:nback`, and going back keeps `bindTopic` | `m:new`: the topic binding is lost and the gate asks again |

The two widened rows above (the tool's error kept, and Resume decided at tap time) come from
the independent review of this change on 2026-10-14, which found that the attach button
trusted an idle time counted from the last prompt in a snapshot up to a scan old, and that
a session another topic already held could be attached a second time.

The session-cap case signed off with this plan, `enforceCap never evicts a busy session`,
is a row of `query-api-rewrite.md`: that plan owns `src/topics.test.ts` and the cap rows the
fix corrects, and the `64-byte` keyboard case there now builds `focusGateKb` as well. Keeping
this plan's suite disjoint from that one's also keeps `test_plan_check.py` honest: today it
merges a sibling plan's case names into the CASE direction too, not only into the ORPHAN
direction its own docstring describes.

### Negative cases

| Case | Must not happen | Mutant it kills |
|---|---|---|
| `readGate: a failing or slow CLI never blocks /new` | waiting past the timeout, or throwing, when the CLI exits non-zero, prints junk, or hangs | awaiting the process without a timeout |
| `focus gate: under the limit or disabled shows nothing` | a prompt when the view says no gate, when there is no view, or when focus is disabled | gating whenever the CLI answers |

## Out of scope

- The item rules (what counts as in flight, the limit, waiting): the focus tool's own plan,
  `~/.claude/scripts/focus/docs/test-plans/focus.md`.
- Recording wrap-ups: the focus tool reads them from the transcript, so telepath needs no hook.
- `bot.ts` wiring: verified at Ring 2 below.

## Ring

Ring 1: `bun run check` and `test_plan_check.py --gate`. Ring 2, by hand on the live bot
after merge: with three or more items in flight, `/new` in General shows the prompt; Start
anyway tapped in General creates the topic; Park creates it and `focus.py list` shows the
item parked; a button from before a daemon restart says it expired; "Start a session here"
then Back keeps the topic.
