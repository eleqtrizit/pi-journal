# pi-journal

Audit trail for file mutations. Overrides pi's built-in `edit` and `write` tools
and records every call to `<cwd>/.pi/tool.log`.

## Behaviour

- Registering a tool under a built-in name replaces that built-in, so `edit` and
  `write` here are the session's only versions of those tools.
- Both tools keep the delegation to pi's real implementation
  (`createEditTool` / `createWriteTool`), so diff rendering, validation and
  truncation are unchanged.
- The journal is written **after** the mutation succeeds. A journal failure
  (read-only volume, bad permissions) surfaces as a UI warning — it never turns
  a successful edit into a tool error.
- Appends go through pi's `withFileMutationQueue`, so concurrent agents sharing a
  workspace cannot interleave partial lines. The `.pi` directory is created on
  first write.

## Design decisions

**`edit` takes one `oldText`/`newText` pair, not pi's `edits[]` array. Do not
"restore" the array.** Pi's built-in accepts several replacements per call and
applies them all-or-nothing, so one bad `oldText` out of five discards the other
four and wastes the whole tool call. A single replacement per call keeps the
failure unit the size of the decision behind it, and keeps each journal record
aligned to exactly one change. Accepted costs: no batched edits, and pi's own
`edit` prompt guidelines are overridden by ours.

**`description` is the first parameter, then `path`, then the payload.** Property
order in the emitted JSON schema is the only lever that nudges a model to state
its intent before producing the diff, and TypeBox preserves the insertion order
of the object literal — verified by `tests/schema-order.test.ts`. Put
`description` back at the end and that nudge disappears silently. This is
unrelated to the log's column order, which stays
`timestamp → level → tool → path → description`.

**Only `edit` and `write` are journalled.** Mutations via `bash` (`sed -i`,
`tee`, redirection, `rm`) are out of scope by design — this records tool calls,
not filesystem activity.

## Log format

`<cwd>/.pi/tool.log` — one record per line, tab-separated:

| Column       | Example                            |
| ------------ | ---------------------------------- |
| ISO timestamp | `2026-03-04T09:12:03.441Z`        |
| Level        | `INFO`                             |
| Tool         | `edit` \| `write`                  |
| Target path  | `src/utils/journal.ts`             |
| Description  | plain-English rationale from the model |

## Layout

| Path | Role |
| ---- | ---- |
| `extensions/index.ts` | Entry point: the two tool overrides and the `/journal` command |
| `src/utils/journal.ts` | Log path, append writer, bounded reader |
| `tests/journal.test.ts` | Vitest coverage of the writer and reader |
| `README.md` | User-facing docs, including the schema rationale |

## Commands

`/journal [n]` — show the last `n` records (default 25).

## Verification

```bash
npx tsc --noEmit
npx vitest run
pi -e ./extensions/index.ts
```

## Conventions

- This is a real extension, not the scaffold — use `pi-template/` when starting a
  new package.
- Import from `@earendil-works/pi-coding-agent` and `typebox`. The
  `@mariozechner/*` and `@sinclair/typebox` scopes are obsolete.
- Relative imports are extensionless (`../src/utils/journal`); pi loads TS via
  jiti and neither package sets `"type": "module"`.

## Pi mechanics Q&A

**How do I tell whether the override is actually live?** Read the schema, not the docs.
Pi's built-in `editSchema` is `{path, edits[]}`; a session whose `edit` takes flat
`oldText`/`newText` is running this extension. Then edit/write a scratch file and read
`<cwd>/.pi/tool.log`. `pi list` will *not* show this package when the session was started
with `-e` — that flag is run-scoped, and does not reach other sessions or spawned teammates.

**Is pi's diff preview really preserved?** Yes, and per-slot. `registerTool` overrides
execution only; omit `renderCall`/`renderResult` and the built-in renderers are used. The
built-in preview path (`getRenderablePreviewInput`, `dist/core/tools/edit.js`) explicitly
accepts the flat `oldText`/`newText` shape, so narrowing the schema keeps the diff.

**Why is `description` the first parameter?** Literal order survives TypeBox into the
emitted schema, which is the only lever for making a model state intent before the diff.
Guarded by `tests/schema-order.test.ts`. It is a nudge, not a guarantee — some backends
normalise schema key order.

**`description` vs `promptSnippet` vs `promptGuidelines`?**

| Surface | Lands in | Notes |
| ------- | -------- | ----- |
| `description` | the tool schema | always sent; only surface that survives `--system-prompt` |
| `promptSnippet` | system prompt `Available tools:` | rendered `- edit: <snippet>`; omit = tool absent |
| `promptGuidelines` | system prompt `Guidelines:` | flat, deduped, ungrouped — every bullet must name its own tool |

Guidelines are included only while the tool is active. Both are dropped entirely when
`--system-prompt` replaces the default prompt (`buildSystemPrompt` short-circuits).

**Does overriding `edit` disable pi's built-in?** No — it is a same-key overwrite.
`_refreshToolRegistry` seeds built-ins into a `Map`, then `.set()`s extension tools on the
same keys, so the built-in entry is gone and there is nothing left to disable. Therefore:
no reachable path to `edits[]` (the single-edit rule is enforced by the schema, not the
prompt); `promptSnippet`/`promptGuidelines` disappear with the built-in definition because
they are rebuilt from that map; and `createEditTool(ctx.cwd)` still runs pi's real
implementation, imported as a library and never registered. Orthogonal to
`--no-builtin-tools`, which filters allow/deny sets before the merge.

## Installation

Not published. Install from the checkout — local paths are recorded in settings
without being copied, so edits to this directory take effect on `/reload`:

```bash
pi install /absolute/path/to/pi-journal     # user scope
pi install -l /absolute/path/to/pi-journal  # project scope → .pi/settings.json
```

Equivalent to adding the directory to `packages` by hand. `pi list` confirms it.
