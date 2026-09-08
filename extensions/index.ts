/**
 * pi-journal — audit trail for file mutations.
 *
 * Registers tools named `edit` and `write`. Registering a tool under a built-in name
 * replaces that built-in, so every file mutation in the session is journalled to
 * `<cwd>/.pi/tool.log` on top of pi's real implementation.
 *
 * Log format: tab-separated `ISO timestamp`, level, tool, target path, description.
 */

import {
	createEditTool,
	type EditToolInput,
	type ExtensionAPI,
	type ExtensionContext,
	createWriteTool,
	type WriteToolInput,
	sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { formatBytes, replayCompactedMessages, writeCompactedSession } from "../src/utils/compact";
import {
	DEFAULT_TAIL_LINES,
	journalPath,
	readRecentEntries,
	recordJournalEntry,
} from "../src/utils/journal";

const EditParams = Type.Object({
	description: Type.String({
		description:
			"Why this edit is needed, in plain English: what changes, what it fixes or enables, and name the " +
			"functions/classes/imports/top-level symbols touched. Fill this in FIRST, before path and the diff.",
	}),
	path: Type.String({
		description:
			"Path to the single file to edit (relative or absolute). Second parameter, after description.",
	}),
	oldText: Type.String({
		description:
			"Exact text to replace. Must match one unique region of the original file byte-for-byte, including " +
			"whitespace. Keep it as small as possible while still unique; do not pad it with large unchanged regions.",
	}),
	newText: Type.String({ description: "Replacement text for that region." }),
});

const WriteParams = Type.Object({
	description: Type.String({
		description:
			"Why this file is being written, in plain English: what it contains and what it is for. " +
			"Fill this in FIRST, before path and content.",
	}),
	path: Type.String({
		description:
			"Path to the file to write (relative or absolute). Parent directories are created. " +
			"Second parameter, after description.",
	}),
	content: Type.String({
		description:
			"Full content to write. This replaces the file entirely — for a partial change to an existing file, " +
			"use edit instead.",
	}),
});

export type EditToolArgs = Static<typeof EditParams>;
export type WriteToolArgs = Static<typeof WriteParams>;

/**
 * Journal a completed tool call without letting a broken log fail the call itself.
 *
 * The file mutation already succeeded, so a journal write failure (read-only volume,
 * permissions) is surfaced as a UI warning rather than turned into a tool error.
 *
 * @param ctx - Extension context providing `cwd` and the UI notifier
 * @param tool - Tool name being journalled, e.g. `"edit"`
 * @param targetPath - Path the tool acted on
 * @param description - Plain-English rationale supplied with the tool call
 */
async function journalled(
	ctx: ExtensionContext,
	tool: string,
	targetPath: string,
	description: string,
): Promise<void> {
	try {
		await recordJournalEntry(ctx.cwd, tool, targetPath, description);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		ctx.ui.notify(`${tool} journal write to ${journalPath(ctx.cwd)} failed: ${reason}`, "warning");
	}
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "edit",
		label: "Edit",
		description:
			"Edit one file with exactly one targeted replacement. `oldText` must match a unique region of the " +
			"original file. Fill parameters in order: description, path, then oldText and newText. " +
			"Make a separate edit call for each change.",
		promptSnippet: "Make precise file edits with exact text replacement, one targeted replacement per call",
		promptGuidelines: [
			"Use edit for precise changes to an existing file; edit's oldText must match exactly one unique region, " +
			"kept as small as possible and never padded with unchanged context.",
			"Use edit with one oldText/newText pair per call; make a separate edit call for each additional change.",
			"When calling edit, fill parameters in this order: description, path, then oldText and newText. " +
			"State the reason for the change before producing the diff.",
		],
		parameters: EditParams,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const builtinEdit = createEditTool(ctx.cwd);
			const input: EditToolInput = {
				path: params.path,
				edits: [{ oldText: params.oldText, newText: params.newText }],
			};
			const result = await builtinEdit.execute(toolCallId, input, signal, onUpdate);

			await journalled(ctx, "edit", params.path, params.description);
			return result;
		},
	});

	pi.registerTool({
		name: "write",
		label: "Write",
		description:
			"Write a file's complete content, replacing whatever was there. Creates the file and any parent " +
			"directories. Fill parameters in order: description, path, then content. Use write only for new files " +
			"or complete rewrites — for a partial change to an existing file, use edit.",
		promptSnippet: "Create or overwrite a file with its complete content",
		promptGuidelines: [
			"Use write only for new files or complete rewrites; use edit for partial changes to an existing file.",
			"When calling write, fill parameters in this order: description, path, then content. " +
			"State the reason for the file before generating its content.",
		],
		parameters: WriteParams,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const builtinWrite = createWriteTool(ctx.cwd);
			const input: WriteToolInput = { path: params.path, content: params.content };
			const result = await builtinWrite.execute(toolCallId, input, signal, onUpdate);

			await journalled(ctx, "write", params.path, params.description);
			return result;
		},
	});

	pi.registerCommand("journal", {
		description: `Show the last ${DEFAULT_TAIL_LINES} entries of .pi/tool.log`,
		handler: async (args, ctx) => {
			const requested = Number.parseInt(args.trim(), 10);
			const limit = Number.isFinite(requested) && requested > 0 ? requested : DEFAULT_TAIL_LINES;
			const entries = await readRecentEntries(ctx.cwd, limit);

			if (entries.length === 0) {
				ctx.ui.notify(`No journal entries in ${journalPath(ctx.cwd)}`, "info");
				return;
			}
			ctx.ui.notify(`Last ${entries.length} journal entries:\n${entries.join("\n")}`, "info");
		},
	});

	pi.registerCommand("journal-compact", {
		description:
			"Rewrite the active context with read/edit/write calls replaced by LOG lines, write an evaluation copy under .pi/journal-compact/, and switch the live session to the compacted context (new session id, original untouched).",
		handler: async (_args, ctx) => {
			const sessionManager = ctx.sessionManager;
			const sourceHeader = sessionManager.getHeader();
			if (sourceHeader === null) {
				ctx.ui.notify("Nothing to compact — the session has not been created yet.", "warning");
				return;
			}

			const messages = sessionManager.buildContextEntries().flatMap(sessionEntryToContextMessages);
			if (messages.length === 0) {
				ctx.ui.notify("Nothing to compact — the context is empty.", "warning");
				return;
			}

			const { path, messages: compacted, stats } = await writeCompactedSession({
				cwd: ctx.cwd,
				sourceHeader,
				sourceFile: sessionManager.getSessionFile(),
				messages,
			});

			const saved = stats.tokensBefore > 0 ? Math.round((1 - stats.tokensAfter / stats.tokensBefore) * 100) : 0;
			ctx.ui.notify(
				`Compacted context written to ${path}\n` +
					`${stats.droppedToolCalls} tool calls replaced by ${stats.logStatements} LOG statements ` +
					`(${stats.logChars} LOG characters); ${stats.keptRecentResults} recent results kept verbatim; ` +
					`${stats.droppedChars} characters of call/result payload dropped.\n` +
					`Serialized context: ${formatBytes(stats.bytesBefore)} → ${formatBytes(stats.bytesAfter)} ` +
					`(bytesBefore=${stats.bytesBefore}, bytesAfter=${stats.bytesAfter}).\n` +
					`Estimated tokens: ${stats.tokensBefore} → ${stats.tokensAfter} (${saved}% smaller). ` +
					`Original session: ${sessionManager.getSessionFile() ?? "(unsaved)"}`,
				"info",
			);

			// Pass 2: adopt the rewrite live. newSession() creates a real session in pi's
			// default session directory (normal id, resume-picker visible) and switches
			// the live context to it; setup() replays the compacted messages into it.
			// Everything after the replacement must use the fresh ReplacedSessionContext
			// passed to withSession — the captured command ctx is stale by then.
			try {
				let switchedTo = "";
				await ctx.newSession({
					setup: async (sessionManager) => {
						replayCompactedMessages(sessionManager, compacted);
					},
					withSession: async (newCtx) => {
						// Runs before newSession() resolves; the closure's switchedTo
						// flag tells it whether the replacement actually happened.
						switchedTo = newCtx.sessionManager.getSessionFile() ?? "";
						newCtx.ui.notify(
							`Live context switched to ${switchedTo}. Evaluation copy: ${path}`,
							"info",
						);
					},
				});
				if (switchedTo === "") {
					ctx.ui.notify(
						`Compacted context written to ${path}, but the live switch was cancelled — still on the original session.`,
						"warning",
					);
				}
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				// If the replacement did happen before the throw, the captured ctx is
				// stale and this notify itself would throw — keep the fallback silent.
				try {
					ctx.ui.notify(
						`Compacted file written to ${path}, but the live switch failed: ${reason}. ` +
							`Open it later with: pi --session ${path}`,
						"warning",
					);
				} catch {
					// stale ctx — the session is already switched; nothing to report to
				}
			}
		},
	});
}
