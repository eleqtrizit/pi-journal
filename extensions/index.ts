/**
 * pi-journal — audit trail for file mutations.
 *
 * Does not register tools. Instead it observes every `edit` and `write` tool
 * result (whoever provides the tools — pi's built-ins or an override such as
 * pi-teams' hash-guarded fs tools) and journals successful mutations to
 * `<cwd>/.pi/tool.log`.
 *
 * Log format: tab-separated `ISO timestamp`, level, tool, target path, description.
 */

import {
	type ExtensionAPI,
	type ExtensionContext,
	type ToolResultEvent,
	sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import { formatBytes, replayCompactedMessages, writeCompactedSession } from "../src/utils/compact";
import { pruneFailedToolResults } from "../src/utils/prune";
import {
	DEFAULT_TAIL_LINES,
	journalPath,
	readRecentEntries,
	recordJournalEntry,
} from "../src/utils/journal";

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
	// Eject failed read/edit/write results from every provider request. Pairing
	// stays valid (stubs, not deletions) and the session file keeps the originals.
	pi.on("context", (event) => {
		const { messages, stats } = pruneFailedToolResults(event.messages);
		if (stats.ejected === 0) {
			return;
		}
		return { messages };
	});

	// Journal successful edit/write mutations from their tool results. Works
	// with any edit/write provider; the path and description come from the
	// call input, and failed calls are not journalled.
	pi.on("tool_result", (event: ToolResultEvent, ctx) => {
		if (event.isError) {
			return;
		}
		if (event.toolName !== "edit" && event.toolName !== "write") {
			return;
		}
		const input = event.input as { path?: unknown; description?: unknown };
		if (typeof input.path !== "string" || typeof input.description !== "string") {
			return;
		}
		return journalled(ctx, event.toolName, input.path, input.description);
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
					`${stats.ejectedErrors} failed edit/read/write results ejected; ` +
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
