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
