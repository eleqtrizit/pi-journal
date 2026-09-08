/**
 * Live-context pruning of failed file-tool results.
 *
 * Failed `edit`, `read`, and `write` tool results are large (stack traces,
 * failed-read payloads) and, once the turn that triggered them is over, carry
 * no information the model still needs. This module replaces their content
 * with a one-line stub so the assistant `toolCall` keeps its paired
 * `toolResult` (dropping the result outright breaks provider APIs) while the
 * error payload leaves every subsequent provider request.
 *
 * The transform is pure: it maps a message list to a pruned copy and never
 * mutates the input. The session file keeps the full results — this only
 * shrinks what is sent to the model.
 *
 * Message types are derived from pi's exported session types because
 * `@earendil-works/pi-ai` and `@earendil-works/pi-agent-core` are not hoisted
 * to this package's `node_modules` root.
 */

import { type SessionMessageEntry } from "@earendil-works/pi-coding-agent";

type AgentMessage = SessionMessageEntry["message"];
type AssistantMessage = Extract<AgentMessage, { role: "assistant" }>;
type ToolResultMessage = Extract<AgentMessage, { role: "toolResult" }>;
type ToolCall = Extract<AssistantMessage["content"][number], { type: "toolCall" }>;

/** Tools whose failed results are pruned. */
export const PRUNED_ERROR_TOOLS: ReadonlySet<string> = new Set(["read", "edit", "write"]);

/** Maximum characters of the original error text kept in a stub. */
const STUB_MAX_CHARS = 200;

/** Tool results — any tool, failed or not — kept verbatim within the keep-recent window. */
export const KEEP_RECENT_RESULTS = 10;

/** Counts of failed read/edit/write results replaced by stubs or kept verbatim. */
export interface PruneStats {
	/** Failed results whose payload was replaced by a stub. */
	ejected: number;
	/** Failed results kept verbatim (within the keep-recent window). */
	kept: number;
}

/**
 * Find the path argument for a result's toolCallId.
 *
 * @param calls - toolCallId → tool call map built from assistant messages
 * @param toolCallId - Id whose path argument is wanted
 * @returns Path argument if available, empty string otherwise
 */
function pathForCall(calls: ReadonlyMap<string, ToolCall>, toolCallId: string): string {
	const value = calls.get(toolCallId)?.arguments?.["path"];
	return typeof value === "string" ? value : "";
}

/** Flattened single-line text carried by a tool-result content array. */
function resultText(content: ToolResultMessage["content"]): string {
	return content
		.map((item) => (item.type === "text" ? item.text : ""))
		.join(" ")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * Build a one-line stub for a failed result, naming the tool, target path,
 * and the original error's first line so the model knows why it was pruned.
 *
 * @param toolName - Tool that failed, e.g. `"edit"`
 * @param targetPath - Path argument of the failed call, may be empty
 * @param originalText - Flattened original error text
 * @returns Stub text for the replacement result
 */
function stubText(toolName: string, targetPath: string, originalText: string): string {
	const summary = targetPath.length > 0 ? `${toolName} ${targetPath}` : toolName;
	return `[error pruned] ${summary} failed: ${originalText.slice(0, STUB_MAX_CHARS)}`;
}

/**
 * Replace the content of failed read/edit/write tool results with stubs.
 *
 * The `keepRecent` most recent tool results — any tool, failed or
 * successful — are kept verbatim, so a failed file-tool result inside the
 * window is still working context the model needs to correct course this turn.
 * Pairing
 * is preserved: every assistant tool call keeps its tool result message, so the
 * pruned context stays API-valid. Results for other tools, and successful
 * results, pass through untouched. The input list is never mutated.
 *
 * @param messages - Active LLM context messages
 * @param keepRecent - How many of the most recent failed results to keep verbatim
 * @returns New message list, plus counts of failed results ejected and kept
 */
export function pruneFailedToolResults(
	messages: readonly AgentMessage[],
	options: { keepRecent?: number } = {},
): { messages: AgentMessage[]; stats: PruneStats } {
	const keepRecent = options.keepRecent ?? KEEP_RECENT_RESULTS;

	const calls = new Map<string, ToolCall>();
	for (const message of messages) {
		if (message.role !== "assistant") {
			continue;
		}
		for (const item of message.content) {
			if (item.type === "toolCall") {
				calls.set(item.id, item);
			}
		}
	}

	const resultIds: string[] = [];
	for (const message of messages) {
		if (message.role === "toolResult") {
			resultIds.push(message.toolCallId);
		}
	}
	const keep = keepRecent <= 0 ? new Set<string>() : new Set(resultIds.slice(-keepRecent));

	let ejected = 0;
	let kept = 0;
	const pruned = messages.map((message): AgentMessage => {
		if (message.role !== "toolResult" || !message.isError || !PRUNED_ERROR_TOOLS.has(message.toolName)) {
			return message;
		}
		if (keep.has(message.toolCallId)) {
			kept += 1;
			return message;
		}
		ejected += 1;
		const text = stubText(message.toolName, pathForCall(calls, message.toolCallId), resultText(message.content));
		return { ...message, content: [{ type: "text", text }] };
	});

	return { messages: pruned, stats: { ejected, kept } };
}
