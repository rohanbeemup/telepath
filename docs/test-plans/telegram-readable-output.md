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
- **False, found by cross-family review after the first green: "chunking is a separate
  concern."** `sayTopic` chunks the RAW markdown and parses each chunk independently, so a
  fenced code block that straddles a boundary loses its fence and the remainder is parsed
  as markdown. Reproduced: 6361 characters of fenced content containing
  `[click here](https://evil.example/pwn)` yields a second chunk where that literal line is
  an active anchor with its destination hidden behind the label, and `**...**` inside the
  fence renders bold. This is inert content becoming active markup, which is why it is in
  scope here rather than deferred. It is pre-existing in this repo, but the back-port would
  have newly introduced it to the live daemon, which sent plain text before.
- **False: "two-column tables are always key/value."** Both the plain and the adversarial
  review flagged it independently. Reproduced: `| Allowed | Forbidden |` with row
  `| read | delete |` rendered as `<b>read</b>: delete`, discarding both headers, so the
  reader cannot tell which value is which. Comparison, permission and before/after tables
  all land in this shape.
- **False, found by the security pass on the fence fix: "tracking fence state makes
  splitting markdown safe."** It does not, because the defect is not fences, it is that
  every chunk is parsed again. Two reproductions defeat the tracker: a hard split of an
  over-long line ending in a fence marker manufactures a standalone closing fence the
  tracker believes, and a fence inside a blockquote is not top-level so it is never
  tracked at all. Both render inert as a whole message and produce an active anchor once
  split. The class fix is to parse the complete message once and split its OUTPUT, so no
  fragment is ever parsed as markdown again.
- **False, found by the security pass on the class fix: "overshooting the limit is safer
  than corrupting a tag."** It is not, because an oversized chunk is refused by Telegram
  and the message is lost entirely. Reproduced: `https://example.com/` plus 5000 `a`
  characters renders to one anchor whose opening tag alone exceeds the budget, so no safe
  cut exists, and the chunk came out at 10055 characters with a 5020-character plain
  fallback. Both are over the 4096 limit, both sends fail, and `sayTopic` logs and moves
  on. Silent loss is worse than a degraded link.
- **False, found by the third security pass: "reserving the closing tags already open is
  enough."** It is not, because the piece being added opens tags of its own. Reproduced:
  `'> '.repeat(150) + 'x'.repeat(2000)` renders to 5750 characters in which the reopen
  prefix plus closing tags cost more than a whole chunk, so no content ever fits, the
  remainder never shrinks, and chunkHtml does not return. sayTopic awaits it on the
  daemon's only thread, so one message would freeze delivery and the Allow/Deny buttons
  for every topic. Severity high: the fix must account for the stack AFTER the candidate
  piece, and must drop formatting it cannot afford rather than failing to make progress.
- **False, found by the fourth security pass: "termination is enough."** Terminating is not
  the same as returning promptly. `safeCut` built its unsafe map over the whole remaining
  line and `fits` ran `applyTags` over the whole remainder, so work grew quadratically:
  measured 250k chars in 42ms, 500k in 122ms, 1M in 510ms, 2M in 2170ms, a clean
  four-times-per-doubling. `sayTopic` runs this synchronously before sending anything, so
  a long enough message blocks the daemon's only thread. Practical exposure is limited,
  since an assistant text block is bounded by the model's output budget, which is why this
  is a medium and not the high that finding 4 was.
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
| `keeps both header labels on a two-column table` | a 2-column table names both columns, so `\| Allowed \| Forbidden \|` cannot be read as key/value | treating every 2-column table as key/value and discarding the header row |
| `keeps a fenced code block inert when it spans a chunk boundary` | a link inside a fence that is split across messages stays literal text in every chunk | chunking the raw markdown and parsing each piece independently |
| `keeps literal content inert when a long line inside it ends in a fence marker` | hard-splitting an over-long line cannot manufacture a fence that reopens parsing | recovering text from the render and re-parsing each piece, the design this replaced |
| `keeps a fenced block inside a blockquote inert when it is split` | a fence that is not top-level is still literal after a split | recovering text from the render and re-parsing each piece, the design this replaced |
| `introduces no href that the whole-message render did not contain` | class-level: splitting can add no link that parsing the complete message did not produce | recovering text from the render and re-parsing each piece, the design this replaced |
| `reopens an open tag in the next chunk and closes it in the emitted one` | a tag left open at a boundary is closed and reopened, so every chunk stands alone | emitting the fragment and letting Telegram reject the unbalanced tag |
| `splits long text at line boundaries` | a chunk ends at a newline rather than mid-word whenever one is available | slicing the whole message at fixed offsets, ignoring line boundaries |
| `degrades a link whose tag alone exceeds the budget to visible text` | an unsplittable anchor becomes escaped text carrying the same URL, rather than an unsendable chunk | dropping the element, losing the destination the reader was shown |
| `keeps every chunk within the limit, even when one link is oversized` | the size guarantee holds for input that cannot be cut safely | the state before this fix: no degrade pass, and the remainder appended whole |
| `terminates on deeply nested formatting` | chunking returns for input whose reopen prefix and closing tags exceed a whole chunk | reserving only the tags already open, ignoring the ones the added piece opens |
| `drops formatting it cannot afford rather than carrying it` | when the tag stack costs more than half the budget it is closed and not reopened, so content keeps flowing | carrying the stack regardless, leaving no room for content |
| `chunks a very long line without quadratic work` | scanning is bounded by the chunk budget, not by what remains, so cost grows with input rather than with its square | rebuilding the unsafe map over the whole remainder on every cut |
| `does not split inside a tag or an entity` | a cut inside `<a href=...>` or `&amp;` never happens, at any limit | cutting at a fixed offset once a line exceeds the budget |

### Negative cases

| Case | Must not happen | Mutant it kills |
|---|---|---|
| `does not wrap a table in a pre block` | no `<pre>` appears in the output for a table input | leaving the old `<pre>` wrapper in place alongside the new rendering |
| `does not treat a paragraph containing pipes as a table` | prose carrying a bare `\|` (a shell pipe) is not restructured | a line scanner that triggers on any `\|` instead of on marked's `table` token |
| `does not drop a row whose first cell is empty` | a row with an empty title cell still emits its remaining columns | a guard that skips the row when the title is falsy, silently losing data |
| `does not emit a chunk Telegram would refuse` | class-level: no chunk, and no plain fallback of one, exceeds the limit for any adversarial input | the state before this fix: no degrade pass, and the remainder appended whole |
| `does not leave an unbalanced tag in any chunk` | class-level: every chunk's tags open and close within it, for any split point | reopening a tag in the next chunk but forgetting to close it in the emitted one |

## Out of scope

- **The live daemon's back-port is a separate, non-git artifact.** `~/.claude/telegram-multiplex`
  is not a git repository, so it cannot hold this plan. It receives the same
  `markdown.ts`, the HTML `sayTopic`, and the `marked` dependency, verified by the
  Ring 2 step below rather than by this suite.
- **Render-then-split, not fence-aware markdown splitting.** The first attempt tracked
  fence state while splitting markdown, and the security pass defeated it twice (see
  Premise). Parsing once and splitting the output removes the class rather than the two
  instances: a chunk of HTML is never parsed as markdown, so no split can manufacture
  markup. The cost is that the splitter must respect HTML instead, which is what the
  `does not split inside a tag or an entity` and `reopens an open tag` cases hold.
- **A table or list split across a boundary still renders as two.** That is cosmetic, not
  a change of kind, and no case covers it.
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
