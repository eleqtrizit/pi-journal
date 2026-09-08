/**
 * Context compaction for journalled tool calls.
 *
 * Replaces `read`, `edit`, and `write` tool calls — together with their tool
 * results — with compact `LOG:` lines inside the assistant's own text, then
 * merges consecutive same-role messages so the compacted context is as small
 * as possible.
 *
 * The transform is pure: `compactMessages` maps a message list to a smaller
 * one plus measured savings; `buildCompactedSession` turns that into a valid
 * pi session file in memory; `writeCompactedSession` persists it under
 * `<cwd>/.pi/journal-compact/`. The live session is never touched — this is
 * an evaluation artifact for deciding whether to adopt the rewrite in-place.
 *
 * Message types are derived from pi's exported session types because
 * `@earendil-works/pi-ai` and `@earendil-works/pi-agent-core` are not hoisted
 * to this package's `node_modules` root.
 */

import {
	CURRENT_SESSION_VERSION,
	estimateTokens,
	type SessionHeader,
	type SessionManager,
	type SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { LOG_DIR_NAME } from "./journal";

type AgentMessage = SessionMessageEntry["message"];
type AssistantMessage = Extract<AgentMessage, { role: "assistant" }>;
type UserMessage = Extract<AgentMessage, { role: "user" }>;
type ToolResultMessage = Extract<AgentMessage, { role: "toolResult" }>;
type AssistantContentItem = AssistantMessage["content"][number];
type ToolCall = Extract<AssistantContentItem, { type: "toolCall" }>;
type TextContent = Extract<AssistantContentItem, { type: "text" }>;
type Usage = AssistantMessage["usage"];

/** Directory (inside the workspace's `.pi`) holding compacted evaluation sessions. */
export const COMPACT_DIR_NAME = "journal-compact";

/** Prefix for every replacement line injected into assistant text. */
export const LOG_PREFIX = "LOG: ";

/** Tools whose calls and results are replaced by LOG lines (except recent ones). */
const JOURNALED_TOOLS = new Set(["read", "edit", "write"]);

/** Most recent journalled tool results kept verbatim — fresh output is still needed as context. */
const KEEP_RECENT_RESULTS = 10;

/** Builds the LOG replacement line for a journalled tool call. */
const LOG_LINE_BUILDERS: Record<string, (args: ToolCall["arguments"]) => string> = {
	edit: (args) => describeToolCall("edit", args),
	write: (args) => describeToolCall("write", args),
	read: (args) => `File read ${stringArg(args, "path")}`,
};

/** Measured effect of a compaction run. */
export interface CompactionStats {
	/** Number of read/edit/write tool calls removed from the context. */
	droppedToolCalls: number;
	/** Characters removed: dropped tool-result text plus dropped call arguments. */
	droppedChars: number;
	/** Characters added: the LOG replacement lines. */
	logChars: number;
	/** Number of LOG replacement statements emitted (one per replaced call). */
	logStatements: number;
	/** Most recent journalled results kept verbatim, not counted as dropped. */
	keptRecentResults: number;
	/** Token estimate of the context before compaction. */
	tokensBefore: number;
	/** Token estimate of the compacted context. */
	tokensAfter: number;
	/** Serialized size in bytes of the context before compaction. */
	bytesBefore: number;
	/** Serialized size in bytes of the compacted context. */
	bytesAfter: number;
}

/** A compacted conversation ready to be persisted as a pi session file. */
export interface CompactedSession {
	header: SessionHeader;
	entries: SessionMessageEntry[];
	stats: CompactionStats;
}

/** Usage reported for rewritten assistant messages: the rewrite spans turns, so per-turn usage is meaningless. */
const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** Short entry id in the same 8-hex-char format pi's SessionManager generates. */
function shortId(): string {
	return randomUUID().slice(0, 8);
}

function stringArg(args: ToolCall["arguments"], key: string): string {
	const value = args?.[key];
	return typeof value === "string" ? value : "";
}

/**
 * Describe an edit or write call by its supplied description, falling back to tool and path
 * when the model omitted one.
 *
 * @param tool - Tool name, e.g. `"edit"`
 * @param args - Tool call arguments
 * @returns One-line description for the LOG entry
 */
function describeToolCall(tool: "edit" | "write", args: ToolCall["arguments"]): string {
	const description = stringArg(args, "description");
	if (description.length > 0) {
		return description.replace(/\s+/g, " ").trim();
	}
	const path = stringArg(args, "path");
	return path.length > 0 ? `${tool} ${path}` : tool;
}

/**
 * Build the LOG replacement line for a tool call, or undefined when the call must be kept.
 *
 * @param name - Tool name from the call
 * @param args - Tool call arguments
 * @returns LOG line (without prefix conflicts — the prefix is added here), or undefined for non-journalled tools
 */
function logLineForCall(name: string, args: ToolCall["arguments"]): string | undefined {
	const builder = LOG_LINE_BUILDERS[name];
	if (builder === undefined) {
		return undefined;
	}
	return `${LOG_PREFIX}${builder(args)}`;
}

/** Total characters of text carried by a tool-result or message content array. */
function contentChars(content: ToolResultMessage["content"] | AssistantContentItem[]): number {
	let total = 0;
	for (const item of content) {
		if (item.type === "text") {
			total += item.text.length;
		}
	}
	return total;
}

function hasToolCalls(message: AgentMessage): boolean {
	return message.role === "assistant" && message.content.some((item) => item.type === "toolCall");
}

/**
 * Identify journalled tool results that must survive compaction: the
 * `keepRecent` most recent ones, identified by toolCallId.
 *
 * @param messages - Input context messages
 * @param keepRecent - How many of the most recent results to keep
 * @returns toolCallIds whose calls and results stay verbatim
 */
function recentJournalledResultIds(messages: AgentMessage[], keepRecent: number): Set<string> {
	if (keepRecent <= 0) {
		return new Set();
	}
	const ids: string[] = [];
	for (const message of messages) {
		if (message.role === "toolResult" && JOURNALED_TOOLS.has(message.toolName)) {
			ids.push(message.toolCallId);
		}
	}
	return new Set(ids.slice(-keepRecent));
}

/**
 * Rebuild one assistant message with journalled calls/results replaced by LOG text.
 *
 * Calls whose results are in the keep-recent set are kept verbatim, together
 * with their results. Thinking content is dropped: it is per-turn reasoning and
 * its signatures are useless once the tool calls it preceded are gone.
 *
 * @param message - Assistant message to shrink
 * @param keepCallIds - toolCallIds whose calls/results stay verbatim (recent results)
 * @param stats - Stats accumulator updated in place
 * @returns The shrunk message, or null when nothing remains (pure tool call, everything dropped)
 */
function shrinkAssistant(
	message: AssistantMessage,
	keepCallIds: ReadonlySet<string>,
	stats: CompactionStats,
): AssistantMessage | null {
	const texts: TextContent[] = [];
	const keptCalls: ToolCall[] = [];
	const logLines: string[] = [];

	for (const item of message.content) {
		if (item.type === "toolCall") {
			const line = logLineForCall(item.name, item.arguments);
			if (line === undefined || keepCallIds.has(item.id)) {
				keptCalls.push(item);
				continue;
			}
			logLines.push(line);
			stats.droppedToolCalls += 1;
			stats.droppedChars += JSON.stringify(item.arguments ?? {}).length;
			continue;
		}
		if (item.type === "thinking") {
			continue;
		}
		texts.push(item);
	}

	if (logLines.length > 0) {
		const logText = logLines.join("\n");
		texts.push({ type: "text", text: logText });
		stats.logChars += logText.length;
		stats.logStatements += logLines.length;
	}

	if (texts.length === 0 && keptCalls.length === 0) {
		return null;
	}

	const content: AssistantContentItem[] = [...texts, ...keptCalls];
	return {
		...message,
		content,
		stopReason: keptCalls.length > 0 ? message.stopReason : "stop",
		usage: keptCalls.length > 0 ? message.usage : ZERO_USAGE,
	};
}

type UserContentItem = Extract<UserMessage["content"], readonly unknown[]>[number];

/** Normalize message content to an item array so same-role messages can merge. */
function toContentArray(message: UserMessage): UserContentItem[] {
	return Array.isArray(message.content) ? message.content : [{ type: "text", text: message.content }];
}

/**
 * Sum pi's token estimate across a message list.
 *
 * @param messages - Context messages
 * @returns Estimated token total
 */
function estimateTotalTokens(messages: AgentMessage[]): number {
	return messages.reduce((total, message) => total + estimateTokens(message), 0);
}

/** Size in bytes of the JSON serialization of a message list. */
function serializedSize(messages: AgentMessage[]): number {
	return Buffer.byteLength(JSON.stringify(messages), "utf-8");
}

/**
 * Format a byte count for humans.
 *
 * @param bytes - Byte count
 * @returns e.g. `"324 B"`, `"13.4 KiB"`, `"2.0 MiB"`
 */
export function formatBytes(bytes: number): string {
	const UNITS = ["B", "KiB", "MiB", "GiB"];
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < UNITS.length - 1) {
		value /= 1024;
		unit += 1;
	}
	return unit === 0 ? `${value} B` : `${value.toFixed(1)} ${UNITS[unit]}`;
}

/**
 * Compact a context message list.
 *
 * Journalled (`read`/`edit`/`write`) tool calls and their results are replaced
 * by `LOG:` lines in the assistant's text — except the
 * {@link KEEP_RECENT_RESULTS} most recent results, which stay verbatim because
 * that fresh output is still needed as working context. Thinking content is
 * dropped, and consecutive same-role plain messages (user, or assistant without
 * remaining tool calls) are merged into single messages. Non-journalled tool
 * pairs pass through untouched so their call/result pairing stays API-valid.
 *
 * @param messages - Active LLM context messages
 * @returns Compacted message list with before/after statistics
 */
export function compactMessages(
	messages: AgentMessage[],
	options: { keepRecentResults?: number } = {},
): { messages: AgentMessage[]; stats: CompactionStats } {
	const stats: CompactionStats = {
		droppedToolCalls: 0,
		droppedChars: 0,
		logChars: 0,
		logStatements: 0,
		keptRecentResults: 0,
		tokensBefore: estimateTotalTokens(messages),
		tokensAfter: 0,
		bytesBefore: serializedSize(messages),
		bytesAfter: 0,
	};

	const keepRecent = options.keepRecentResults ?? KEEP_RECENT_RESULTS;
	const keepCallIds = recentJournalledResultIds(messages, keepRecent);
	stats.keptRecentResults = Math.min(keepRecent, keepCallIds.size);

	const kept: AgentMessage[] = [];
	for (const message of messages) {
		if (message.role === "toolResult") {
			if (JOURNALED_TOOLS.has(message.toolName) && !keepCallIds.has(message.toolCallId)) {
				stats.droppedChars += contentChars(message.content);
				continue;
			}
			kept.push(message);
			continue;
		}
		if (message.role === "assistant") {
			const shrunk = shrinkAssistant(message, keepCallIds, stats);
			if (shrunk !== null) {
				kept.push(shrunk);
			}
			continue;
		}
		kept.push(message);
	}

	const merged = coalesce(kept);
	stats.tokensAfter = estimateTotalTokens(merged);
	stats.bytesAfter = serializedSize(merged);
	return { messages: merged, stats };
}

/**
 * Merge consecutive user messages, and consecutive tool-call-free assistant
 * messages, into single messages.
 *
 * @param messages - Compacted message list
 * @returns List with same-role runs collapsed
 */
function coalesce(messages: AgentMessage[]): AgentMessage[] {
	const result: AgentMessage[] = [];
	for (const message of messages) {
		const previous = result.at(-1);
		if (previous !== undefined && canMerge(previous, message)) {
			result[result.length - 1] = mergeMessages(previous, message);
			continue;
		}
		result.push(message);
	}
	return result;
}

/** Whether two adjacent messages may be merged into one. */
function canMerge(a: AgentMessage, b: AgentMessage): boolean {
	if (a.role !== b.role) {
		return false;
	}
	if (a.role === "user") {
		return true;
	}
	if (a.role !== "assistant" || b.role !== "assistant") {
		return false;
	}
	return !hasToolCalls(a) && !hasToolCalls(b);
}

/** Merge two adjacent same-role messages, joining their text with a blank line. */
function mergeMessages(a: AgentMessage, b: AgentMessage): AgentMessage {
	if (a.role === "user" && b.role === "user") {
		return { ...a, content: [...toContentArray(a), ...toContentArray(b)] };
	}
	if (a.role === "assistant" && b.role === "assistant") {
		const text = [
			...a.content.filter((item): item is TextContent => item.type === "text"),
			...b.content.filter((item): item is TextContent => item.type === "text"),
		]
			.map((item) => item.text)
			.join("\n\n");
		return { ...a, content: [{ type: "text", text }], stopReason: "stop", usage: ZERO_USAGE };
	}
	return b;
}

/**
 * Build an in-memory pi session file holding the compacted conversation.
 *
 * Entries are re-chained linearly (each entry's parent is its predecessor) so
 * the file is a valid, navigable session. The new header points back at the
 * source session via `parentSession`.
 *
 * @param sourceHeader - Header of the session being compacted
 * @param sourceFile - Path of the source session file (recorded as `parentSession`)
 * @param messages - Compacted context messages
 * @returns Header, chained entries, and stats
 */
export function buildCompactedSession(
	sourceHeader: SessionHeader,
	sourceFile: string | undefined,
	messages: AgentMessage[],
): { header: SessionHeader; entries: SessionMessageEntry[] } {
	const timestamp = new Date().toISOString();
	const header: SessionHeader = {
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id: randomUUID(),
		timestamp,
		cwd: sourceHeader.cwd,
		parentSession: sourceFile,
	};

	const entries: SessionMessageEntry[] = [];
	let parentId: string | null = null;
	for (const message of messages) {
		const entryTimestamp = Number.isFinite(message.timestamp)
			? new Date(message.timestamp).toISOString()
			: timestamp;
		const entry: SessionMessageEntry = {
			type: "message",
			id: shortId(),
			parentId,
			timestamp: entryTimestamp,
			message,
		};
		entries.push(entry);
		parentId = entry.id;
	}

	return { header, entries };
}

/** Directory holding compacted evaluation sessions for a workspace. */
export function compactDir(cwd: string): string {
	return join(cwd, LOG_DIR_NAME, COMPACT_DIR_NAME);
}

/**
 * Replay compacted context messages into a fresh session.
 *
 * Used to adopt a compaction live: `newSession({ setup })` a new session in
 * pi's default session directory — a real session id, resume-picker visible —
 * and replay the compacted messages into it. Compaction/branch summary
 * messages cannot be appended as messages (pi stores them as top-level
 * entries), so they are replayed as user text carrying the summary.
 *
 * @param sessionManager - Writable session being initialized
 * @param messages - Compacted context messages, in conversation order
 */
export function replayCompactedMessages(sessionManager: SessionManager, messages: AgentMessage[]): void {
	for (const message of messages) {
		if (message.role === "compactionSummary" || message.role === "branchSummary") {
			sessionManager.appendMessage({
				role: "user",
				content: message.summary,
				timestamp: message.timestamp,
			});
			continue;
		}
		sessionManager.appendMessage(message as Parameters<SessionManager["appendMessage"]>[0]);
	}
}

/**
 * Compact the active context and persist it as a new pi session file.
 *
 * The output lives at `<cwd>/.pi/journal-compact/<timestamp>_<id>.jsonl` and
 * can be opened with `pi --session <path>` for side-by-side evaluation. The
 * live session is never modified.
 *
 * @param options.cwd - Workspace root
 * @param options.sourceHeader - Header of the session being compacted
 * @param options.sourceFile - Path of the source session file (may be undefined for unsaved sessions)
 * @param options.messages - Active LLM context messages
 * @returns Output path, compacted messages, and measured savings
 * @throws {@link Error} If the session cannot be written to disk
 */
export async function writeCompactedSession(options: {
	cwd: string;
	sourceHeader: SessionHeader;
	sourceFile: string | undefined;
	messages: AgentMessage[];
}): Promise<{ path: string; messages: AgentMessage[]; stats: CompactionStats }> {
	const { messages, stats } = compactMessages(options.messages);
	const compacted = buildCompactedSession(options.sourceHeader, options.sourceFile, messages);

	const fileTimestamp = compacted.header.timestamp.replace(/[:.]/g, "-");
	const path = join(compactDir(options.cwd), `${fileTimestamp}_${shortId()}.jsonl`);
	const lines = [compacted.header, ...compacted.entries].map((entry) => `${JSON.stringify(entry)}\n`);

	await mkdir(compactDir(options.cwd), { recursive: true });
	await writeFile(path, lines.join(""), "utf-8");

	return { path, messages, stats };
}
