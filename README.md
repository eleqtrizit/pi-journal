# pi-journal

Audit trail for file mutations in [pi](https://pi.dev) coding agent sessions.

It registers tools named `edit` and `write`. Because registering a tool under a
built-in name replaces that built-in, every file mutation in the session is
recorded to `<cwd>/.pi/tool.log` on top of pi's real implementation.

## Why

Agent sessions make a lot of edits. When something breaks later, there is
usually no record of which change was responsible, or why it was made. This
extension keeps a cheap, append-only trail of every mutation together with the
model's own plain-English rationale for it — so `git blame` answers *what*
changed and the journal answers *why*, including for files that are untracked,
gitignored, or not in a repository at all.

## Install

```bash
pi install /absolute/path/to/pi-journal    # user scope → ~/.pi/agent/settings.json
pi install -l /absolute/path/to/pi-journal # project scope → .pi/settings.json
```

Local-path packages are recorded in settings without being copied, so the
checkout stays the source of truth — edit the files and `/reload`.

To try it without installing, for a single run only:

```bash
pi -e ./extensions/index.ts
```

## Log format

`<cwd>/.pi/tool.log` — one record per line, tab-separated:

| Column      | Example                                 |
| ----------- | --------------------------------------- |
| ISO timestamp | `2026-03-04T09:12:03.441Z`            |
| Level       | `INFO`                                  |
| Tool        | `edit` \| `write`                       |
| Target path | `src/utils/journal.ts`                  |
| Description | plain-English rationale from the model  |

```
2026-03-04T09:12:03.441Z	INFO	edit	src/utils/journal.ts	Extract the append writer out of the tool handler
```

The journal is written **after** the mutation succeeds. A journal failure
(read-only volume, bad permissions) surfaces as a UI warning rather than turning
a successful edit into a tool error. Appends go through pi's
`withFileMutationQueue`, so concurrent agents sharing a workspace cannot
interleave partial lines.

Add `*.log` to `.gitignore` if you want the trail kept out of version control.

## Commands

`/journal [n]` — show the last `n` records (default 25).

`/journal-compact` — rewrite the active LLM context so that every `read`,
`edit`, and `write` tool call and its result is replaced by a compact `LOG:`
line inside the assistant's own text, then merge consecutive same-role messages
so the sequence collapses as far as possible:

```
assistant: "LOG: File read src/app.ts
LOG: Extract the append writer out of the tool handler
LOG: Create tests/app.test.ts

Reader and writer are now separate helpers, ..."
```

- `edit`/`write` become `LOG: <description>` — the rationale the model supplied
  with the call. A missing description degrades to `LOG: <tool> <path>`.
- `read` becomes `LOG: File read <path>`.
- The 10 most recent journalled tool results are kept verbatim — that fresh
  output is still needed as working context and is not worth losing. Older
  pairs beyond that window are the ones compacted.
- Non-journalled tool pairs (bash, grep, …) are kept intact so their
  call/result pairing stays API-valid.
- Thinking blocks are dropped: per-turn reasoning whose tool calls are gone has
  no value.

**The evaluation file.** The compacted context is also written as a valid pi
session file to `<cwd>/.pi/journal-compact/<timestamp>_<id>.jsonl` — a new
session id and `parentSession` pointing back at the original — for diffing and
side-by-side review. The command reports measured savings (tool calls replaced,
characters dropped, estimated tokens before → after, serialized context bytes
before → after) and prints the original session path.

Measured on real sessions: 46–91% estimated-token reduction.

**Pass 2 is implemented — the compaction now adopts live.** After writing the
evaluation file, the command starts a real pi session in the default session
directory (normal session id, visible in the resume picker), replays the
compacted messages into it via `newSession({ setup })` +
`replayCompactedMessages()`, and switches the live context to it. The original
session file is never modified; its path is printed in the report so you can
go back with `pi --session <original>`.

Session-file notes: entries are re-chained linearly (each entry's parent is its
predecessor); rewritten assistant messages carry zeroed usage because a merged
message spans turns, so per-turn usage is meaningless — after resuming the
compacted file, the first real response re-anchors pi's context estimates.


## Design decisions

**`edit` takes one `oldText`/`newText` pair, not pi's `edits[]` array.** This is
deliberate, not an oversight. Pi's built-in accepts an array of replacements in
a single call, and the whole call succeeds or fails together — so one bad
`oldText` out of five discards the other four and burns a round trip redoing
them. Narrowing the schema to a single replacement keeps the failure unit as
small as the decision behind it: a rejected edit is one edit, and the journal
record still describes exactly what was attempted.

Consequences accepted with that trade:

- Batched multi-edit calls are no longer available; expect more tool calls for
  wide mechanical changes.
- Pi's own `edit` prompt guidelines are replaced by this extension's.
- The tool description, not the schema, is what steers the model back toward
  one targeted change at a time.

**`description` comes first in both parameter lists**, ahead of `path`. The
journal's value is the rationale, and putting it first in the schema is what
nudges the model to commit to a reason before it commits to a diff. Schema
property order is the only mechanism available for that, so it is load-bearing —
keep the literals in that order.

**Only `edit` and `write` are journalled.** Mutations through `bash` — `sed -i`,
`tee`, redirection, `rm` — are not recorded. This is a record of tool calls, not
a filesystem monitor.

## Development

```bash
npx tsc --noEmit
npx vitest run
pi -e ./extensions/index.ts   # manual smoke test: edit/write, then /journal
```

## Conventions

- Import from `@earendil-works/pi-coding-agent` and `typebox`. The
  `@mariozechner/*` and `@sinclair/typebox` scopes are obsolete.
- Relative imports are extensionless (`../src/utils/journal`); pi loads TS via
  jiti and neither package sets `"type": "module"`.
