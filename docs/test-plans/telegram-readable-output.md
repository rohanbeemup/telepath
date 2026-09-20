---
feature: Tables Claude writes arrive in Telegram as readable labelled blocks instead of a pipe grid
suite:
  - markdown.test.ts
gate: bun test markdown.test.ts
---

# Telegram-readable table output

## Premise

The request: the Telegram integrator posts messages in tabular format, which is
unreadable on Telegram.

What was checked, and what turned out false:

- **False: "the daemon needs a table converter added."** There are two daemons and
  they are in different states. The live service
  (`systemctl --user cat claude-telegram-multiplex` resolves to
  `~/.claude/telegram-multiplex/daemon.ts`, 799 lines) calls `sendMessage` with **no
  `parse_mode` at all**, so every markdown construct arrives literally: `| a | b |`,
  `**bold**`, `### heading`. This repo's `daemon.ts` (1620 lines) has since grown a
  `marked`-based markdown to Telegram-HTML renderer (`mdInline`, `mdBlock`,
  `mdToTelegramHtml`) that was never back-ported. The live daemon is behind, not
  missing a converter.
- **Still true for this repo: the table rendering is tabular.** `case 'table'` in
  `mdBlock` pipe-joins each row and wraps the lot in `<pre>`. Telegram does not wrap
  `<pre>`; it scrolls horizontally, so on a phone a four-column table is a sliver.
  That is the defect this plan fixes.
- **Ruled out as the "integrator":** `contabo-server-config/kafka-telegram-relay/formatters.js`
  and `backend/shared/telegram/formatters.ts`. Both emit `<b>` and `<code>` bullet
  lists and contain no table construction (grepped for `|---`, `padEnd`, column joins).

## Cases

| Case | Asserts | Mutant it kills |
|---|---|---|
| `renders a multi-column table as one labelled block per row` | each data row becomes a title line from column 1 plus one `label: value` line per remaining column | keeping the pipe grid and only changing the wrapper tag |
| `collapses a two-column table to one line per row` | a 2-column table yields one `key: value` line per row, not a two-line block | a uniform block-per-row rule that doubles the length of every key/value table |
| `uses the header cells as labels in the order they appear` | label *n* comes from header cell *n*, not from position 1 or a sorted order | labelling every column with the first data column's header |
| `emits no pipe-joined grid for any table` | class-level: no output line carries the `x \| y` row shape for any table input | any partial conversion that leaves wide tables as rows |
| `keeps a fenced code block that contains pipes verbatim` | text inside a fenced code block is passed through unchanged | rendering a fenced block through the text path, so its pipes are eaten like a table's |
| `keeps inline formatting inside table cells` | `**bold**` in a cell survives as `<b>` in the block output | dropping to `t.text` and losing inline tokens |
| `escapes HTML special characters in cells exactly once` | a cell containing `&` and `<` yields `&amp;` and `&lt;`, never `&amp;amp;` | calling `htmlEsc` on output that `mdInline` already escaped |
| `drops empty cells instead of emitting a bare label` | an empty cell produces no `label:` line at all | an unconditional join over every column |
| `renders a table with a single data row` | a 1-row table still renders as a block, with no leading or trailing blank noise | an implementation that needs two or more rows to emit anything |
| `renders every table in a message and preserves surrounding prose order` | two tables separated by prose come back in source order with the prose between them | a "first table only" implementation |
| `still renders headings, lists, code and links as before` | the non-table branches of `mdBlock` are untouched by this change | dropping the bold on headings while rewriting the block walk |

### Negative cases

| Case | Must not happen | Mutant it kills |
|---|---|---|
| `does not wrap a table in a pre block` | no `<pre>` appears in the output for a table input | leaving the old `<pre>` wrapper in place alongside the new rendering |
| `does not treat a paragraph containing pipes as a table` | prose carrying a bare `\|` (a shell pipe) is not restructured | a line scanner that triggers on any `\|` instead of on marked's `table` token |
| `does not drop a row whose first cell is empty` | a row with an empty title cell still emits its remaining columns | a guard that skips the row when the title is falsy, silently losing data |

## Out of scope

- **The live daemon's back-port is a separate, non-git artifact.** `~/.claude/telegram-multiplex`
  is not a git repository, so it cannot hold this plan. It receives the same
  `markdown.ts`, the HTML `sayTopic`, and the `marked` dependency, verified by the
  Ring 2 step below rather than by this suite.
- **`chunk()` is unchanged.** Splitting a long message is a separate concern; a block
  that straddles a chunk boundary is pre-existing behaviour.
- **MarkdownV2 is not revisited.** The HTML subset plus the plain-text fallback is the
  existing decision in this repo, and this change does not reopen it.
- **The other Telegram senders are untouched.** `kafka-telegram-relay` and the
  backend's `shared/telegram/` emit bullet lists already (see Premise).

## Ring

Ring 1 (unit): `bun test markdown.test.ts` covers the whole conversion, since
`mdToTelegramHtml` is a pure string-to-string function once extracted into
`markdown.ts`.

Ring 2 is not reachable from this suite and is the handoff: restart the live service
(`systemctl --user restart claude-telegram-multiplex`), have a session emit a real
multi-column table into a topic, and read it on the phone. Green here is a handoff,
not done.
