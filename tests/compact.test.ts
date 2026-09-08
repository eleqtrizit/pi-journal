import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseSessionEntries, type SessionHeader } from "@earendil-works/pi-coding-agent";
import {
	buildCompactedSession,
	compactDir,
	compactMessages,
	compactMessages as compactMessagesDefault,
	type CompactionStats,
	formatBytes,
	LOG_PREFIX,
	writeCompactedSession,
} from "../src/utils/compact";
import { LOG_DIR_NAME } from "../src/utils/journal";

type AgentMessage = Parameters<typeof compactMessages>[0][number];
type AssistantMessage = Extract<AgentMessage, { role: "assistant" }>;
type UserMessage = Extract<AgentMessage, { role: "user" }>;
type ToolResultMessage = Extract<AgentMessage, { role: "toolResult" }>;

let workspace = "";

beforeEach(async () => {
	workspace = await mkdtemp(join(tmpdir(), "pi-journal-compact-"));
});

afterEach(async () => {
	await rm(workspace, { recursive: true, force: true });
});

const ZERO_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/**
 * Build an assistant message with a realistic envelope.
 *
 * @param content - Content items: text blocks, thinking blocks, or tool calls
 * @param overrides - Field overrides (stopReason, usage, ...)
 */
function assistant(
	content: AssistantMessage["content"],
	overrides: Partial<AssistantMessage> = {},
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-test",
		usage: ZERO_USAGE,
		stopReason: "stop",
		timestamp: Date.parse("2026-03-04T09:00:00Z"),
		...overrides,
	};
}

function user(text: string, overrides: Partial<UserMessage> = {}): UserMessage {
	return { role: "user", content: text, timestamp: Date.parse("2026-03-04T08:59:00Z"), ...overrides };
}

function toolResult(
	toolName: string,
	text: string,
	toolCallId = `${toolName}-1`,
): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text }],
		isError: false,
		timestamp: Date.parse("2026-03-04T09:00:01Z"),
	};
}

function call(name: string, args: Record<string, unknown>, id = `${name}-1`): Extract<AssistantMessage["content"][number], { type: "toolCall" }> {
	return { type: "toolCall", id, name, arguments: args };
}

/** Compact and return just the messages (no recent-result retention). */
function compact(messages: AgentMessage[]): AgentMessage[] {
	return compactMessages(messages, { keepRecentResults: 0 }).messages;
}

/** Compact with stats (no recent-result retention). */
function runCompact(messages: AgentMessage[]) {
	return compactMessages(messages, { keepRecentResults: 0 });
}

describe("compactMessages — LOG replacement", () => {
	it("replaces edit and write descriptions with LOG lines", () => {
		const result = compact([
			user("do it"),
			assistant([
				{ type: "text", text: "making the change" },
				call("edit", { description: "Rename handler in src/app.ts" }),
				call("write", { description: "Create tests/app.test.ts" }),
			]),
			toolResult("edit", "ok"),
			toolResult("write", "ok"),
		]);

		expect(result).toHaveLength(2);
		const reply = result[1] as AssistantMessage;
		expect(reply.role).toBe("assistant");
		const text = reply.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
		expect(text).toContain(`${LOG_PREFIX}Rename handler in src/app.ts`);
		expect(text).toContain(`${LOG_PREFIX}Create tests/app.test.ts`);
		expect(reply.content.some((item) => item.type === "toolCall")).toBe(false);
	});

	it("replaces read calls with LOG: File read <path>", () => {
		const result = compact([
			user("look"),
			assistant([{ type: "text", text: "checking" }, call("read", { path: "src/app.ts" })]),
			toolResult("read", "…10k chars of file contents…"),
		]);

		const reply = result[1] as AssistantMessage;
		const text = reply.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
		expect(text).toContain(`${LOG_PREFIX}File read src/app.ts`);
		expect(result.some((message) => message.role === "toolResult")).toBe(false);
	});

	it("replaces a pure read call with a LOG-only assistant message", () => {
		const result = compact([
			user("a"),
			assistant([call("read", { path: "x.ts" })]),
			toolResult("read", "contents"),
			user("b"),
		]);

		expect(result).toHaveLength(3);
		const logMessage = result[1] as AssistantMessage;
		expect(logMessage.content).toEqual([{ type: "text", text: `${LOG_PREFIX}File read x.ts` }]);
		expect(logMessage.stopReason).toBe("stop");
	});

	it("drops an assistant message with no content at all", () => {
		const result = compact([user("a"), assistant([]), user("b")]);

		expect(result).toHaveLength(1);
		expect((result[0] as UserMessage).content).toEqual([
			{ type: "text", text: "a" },
			{ type: "text", text: "b" },
		]);
	});

	it("drops thinking content from assistant messages", () => {
		const result = compact([
			user("a"),
			assistant([
				{ type: "thinking", thinking: "long deliberation" },
				{ type: "text", text: "answer" },
			]),
		]);

		const reply = result[1] as AssistantMessage;
		expect(reply.content.map((item) => item.type)).toEqual(["text"]);
	});
});

describe("compactMessages — kept pairs", () => {
	it("keeps the last 10 journalled results verbatim and drops older ones", () => {
		const input: AgentMessage[] = [];
		for (let index = 0; index < 12; index += 1) {
			input.push(assistant([call("read", { path: `f${index}.ts` }, `r${index}`)]));
			input.push(toolResult("read", `contents ${index}`, `r${index}`));
		}
		const { messages, stats } = compactMessagesDefault(input);

		// Oldest 2 pairs collapse into LOG statements; the 10 most recent stay intact.
		expect(stats.droppedToolCalls).toBe(2);
		expect(stats.keptRecentResults).toBe(10);
		const keptResults = messages.filter(
			(message): message is ToolResultMessage => message.role === "toolResult",
		);
		expect(keptResults).toHaveLength(10);
		expect(keptResults[0].toolCallId).toBe("r2");
		expect(keptResults[9].toolCallId).toBe("r11");
		const logText = messages
			.filter((message) => message.role === "assistant")
			.flatMap((message) => message.content)
			.filter((item) => item.type === "text")
			.map((item) => item.text)
			.join("\n");
		expect(logText).toContain("File read f0.ts");
		expect(logText).toContain("File read f1.ts");
		expect(logText).not.toContain("File read f2.ts");
		// Calls of kept results survive too.
		const keptCalls = messages
			.flatMap((message) => (message.role === "assistant" ? message.content : []))
			.filter((item) => item.type === "toolCall");
		expect(keptCalls).toHaveLength(10);
	});

	it("keeps non-journalled tool calls and results intact", () => {
		const result = compact([
			user("a"),
			assistant([{ type: "text", text: "searching" }, call("bash", { command: "ls" }, "bash-1")]),
			toolResult("bash", "file.ts\n", "bash-1"),
		]);

		expect(result).toHaveLength(3);
		expect((result[1] as AssistantMessage).content.some((item) => item.type === "toolCall")).toBe(true);
		expect((result[2] as ToolResultMessage).role).toBe("toolResult");
	});

	it("keeps a bash pair inside a mixed assistant message while dropping the read pair", () => {
		const result = compact([
			user("a"),
			assistant([call("read", { path: "a.ts" }, "r1"), call("bash", { command: "ls" }, "b1")]),
			toolResult("read", "contents", "r1"),
			toolResult("bash", "out", "b1"),
		]);

		expect(result).toHaveLength(3);
		const assistantMessage = result[1] as AssistantMessage;
		const calls = assistantMessage.content.filter((item) => item.type === "toolCall");
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({ name: "bash", id: "b1" });
		const text = assistantMessage.content.filter((item) => item.type === "text").map((item) => item.text).join("");
		expect(text).toContain(`${LOG_PREFIX}File read a.ts`);
		expect((result[2] as ToolResultMessage).toolCallId).toBe("b1");
	});
});

describe("compactMessages — coalescing", () => {
	it("merges consecutive assistant messages separated only by dropped results", () => {
		const result = compact([
			user("a"),
			assistant([{ type: "text", text: "first" }, call("read", { path: "a.ts" }, "r1")]),
			toolResult("read", "contents", "r1"),
			assistant([{ type: "text", text: "second" }, call("edit", { description: "fix a.ts" }, "e1")]),
			toolResult("edit", "ok", "e1"),
			assistant([{ type: "text", text: "done" }]),
		]);

		// The run with a kept... (no kept calls here) — everything collapses between the two users.
		expect(result).toHaveLength(2);
		const merged = result[1] as AssistantMessage;
		const text = merged.content.filter((item) => item.type === "text").map((item) => item.text).join("\n\n");
		expect(text).toBe(
			"first\n\nLOG: File read a.ts\n\nsecond\n\nLOG: fix a.ts\n\ndone",
		);
		expect(merged.content.some((item) => item.type === "toolCall")).toBe(false);
		expect(merged.stopReason).toBe("stop");
	});

	it("does not merge across a kept tool result", () => {
		const result = compact([
			user("a"),
			assistant([{ type: "text", text: "running" }, call("bash", { command: "ls" }, "b1")]),
			toolResult("bash", "out", "b1"),
			assistant([{ type: "text", text: "done" }]),
		]);

		expect(result).toHaveLength(4);
	});

	it("merges consecutive user messages", () => {
		const result = compact([user("a"), user("b")]);
		expect(result).toHaveLength(1);
		expect((result[0] as UserMessage).content).toEqual([{ type: "text", text: "a" }, { type: "text", text: "b" }]);
	});
});

/**
 * Count LOG statements across all assistant text in a compacted message list.
 *
 * @param messages - Compacted messages
 * @returns Number of lines beginning with the LOG prefix
 */
function countLogLines(messages: AgentMessage[]): number {
	let count = 0;
	for (const message of messages) {
		if (message.role === "assistant") {
			for (const item of message.content) {
				if (item.type === "text") {
					count += item.text.split("\n").filter((line) => line.startsWith(LOG_PREFIX)).length;
				}
			}
		}
	}
	return count;
}

/** Count journalled tool calls in an input message list. */
function countJournalledCalls(messages: AgentMessage[]): number {
	return messages.reduce((total, message) => {
		if (message.role !== "assistant") {
			return total;
		}
		return total + message.content.filter((item) => item.type === "toolCall" && JOURNALED.has(item.name)).length;
	}, 0);
}

const JOURNALED = new Set(["read", "edit", "write"]);

describe("compactMessages — stats", () => {
	it("every LOG line corresponds 1:1 to a replaced journalled tool call", () => {
		const input: AgentMessage[] = [
			user("a", { timestamp: 0 }),
			assistant([
				{ type: "text", text: "plan" },
				call("read", { path: "a.ts" }, "r1"),
				call("edit", { description: "first edit" }, "e1"),
			]),
			toolResult("read", "a contents", "r1"),
			toolResult("edit", "ok", "e1"),
			assistant([call("write", { description: "new file" }, "w1"), call("bash", { command: "ls" }, "b1")]),
			toolResult("write", "ok", "w1"),
			toolResult("bash", "out", "b1"),
			// A user message containing "LOG:" text must not be counted; only assistant replacements count.
			user("please LOG: File read nope.ts", { timestamp: 0 }),
		];

		const expected = countJournalledCalls(input); // read, edit, write = 3 (bash untouched)
		const { messages, stats } = runCompact(input);

		expect(expected).toBe(3);
		expect(stats.droppedToolCalls).toBe(expected);
		expect(stats.logStatements).toBe(expected);
		expect(countLogLines(messages)).toBe(expected);
	});

	it("reports dropped characters, LOG characters, and a lower token estimate", () => {
		const bigFile = "x".repeat(20000);
		const before = [
			user("a", { timestamp: 0 }),
			assistant([{ type: "text", text: "reading" }, call("read", { path: "big.ts" }, "r1")]),
			toolResult("read", bigFile, "r1"),
			assistant([{ type: "text", text: "it is long" }]),
		];

		const { messages, stats } = runCompact(before);

		expect(messages).toHaveLength(2);
		expect(stats.droppedToolCalls).toBe(1);
		expect(stats.droppedChars).toBeGreaterThan(20000);
		expect(stats.logChars).toBeGreaterThan(0);
		expect(stats.tokensAfter).toBeLessThan(stats.tokensBefore);
	});
});

describe("buildCompactedSession", () => {
	const sourceHeader: SessionHeader = {
		type: "session",
		version: 3,
		id: "019612ab-cdef-7def-8abc-1234567890ab",
		timestamp: "2026-03-04T09:00:00.000Z",
		cwd: "/work/tree",
	};

	it("chains entries linearly and records the parent session", () => {
		const { messages } = runCompact([user("a"), assistant([{ type: "text", text: "b" }])]);
		const { header, entries } = buildCompactedSession(sourceHeader, "/sessions/orig.jsonl", messages);

		expect(header.parentSession).toBe("/sessions/orig.jsonl");
		expect(header.cwd).toBe("/work/tree");
		expect(header.parentSession).not.toBe(sourceHeader.id);
		expect(entries[0].parentId).toBeNull();
		for (let index = 1; index < entries.length; index += 1) {
			expect(entries[index].parentId).toBe(entries[index - 1].id);
		}
		expect(entries.map((entry) => entry.type)).toEqual(["message", "message"]);
		expect(entries.every((entry) => entry.message != null)).toBe(true);
	});
});

describe("writeCompactedSession", () => {
	it("writes a parseable pi session file under .pi/journal-compact/", async () => {
		const sourceHeader: SessionHeader = {
			type: "session",
			version: 3,
			id: "019612ab-cdef-7def-8abc-1234567890ab",
			timestamp: "2026-03-04T09:00:00.000Z",
			cwd: workspace,
		};
		const messages: AgentMessage[] = [
			user("a"),
			assistant([{ type: "text", text: "reading" }, call("read", { path: "a.ts" }, "r1")]),
			toolResult("read", "contents", "r1"),
		];

		const { path, stats } = await writeCompactedSession({
			cwd: workspace,
			sourceHeader,
			sourceFile: "/sessions/orig.jsonl",
			messages,
		});

		expect(path.startsWith(compactDir(workspace))).toBe(true);
		expect(path.endsWith(".jsonl")).toBe(true);

		const content = await readFile(path, "utf-8");
		const fileEntries = parseSessionEntries(content);
		expect(fileEntries[0]).toMatchObject({ type: "session", cwd: workspace, parentSession: "/sessions/orig.jsonl" });
		// The single read result is recent (<= 10), so it is kept verbatim: header + user + call + result.
		expect(fileEntries).toHaveLength(4);
		expect(fileEntries[3]).toMatchObject({ type: "message", message: { role: "toolResult", toolName: "read" } });
		expect(stats.droppedToolCalls).toBe(0);
		expect(path.includes(join(LOG_DIR_NAME, "journal-compact"))).toBe(true);
	});
});

describe("stats shape", () => {
	it("exposes all measured fields", () => {
		const { stats } = runCompact([user("a")]);
		const keys = Object.keys(stats).sort();
		expect(keys).toEqual(
			["bytesAfter", "bytesBefore", "droppedChars", "droppedToolCalls", "keptRecentResults", "logChars", "logStatements", "tokensAfter", "tokensBefore"].sort(),
		);
		const typedStats: CompactionStats = stats;
		expect(typedStats.tokensBefore).toBeGreaterThan(0);
		expect(typedStats.bytesBefore).toBeGreaterThan(0);
		expect(typedStats.bytesAfter).toBeGreaterThan(0);
	});

	it("measures serialized bytes before and after", () => {
		const bigFile = "x".repeat(20000);
		const { stats } = runCompact([
			user("a", { timestamp: 0 }),
			assistant([{ type: "text", text: "reading" }, call("read", { path: "big.ts" }, "r1")]),
			toolResult("read", bigFile, "r1"),
		]);

		expect(stats.bytesAfter).toBeLessThan(stats.bytesBefore);
		// The 20k-char result is gone; LOG text plus metadata remains.
		expect(stats.bytesBefore - stats.bytesAfter).toBeGreaterThan(20000);
	});

	it("formats byte counts for humans", () => {
		expect(formatBytes(324)).toBe("324 B");
		expect(formatBytes(13 * 1024 + 410)).toBe("13.4 KiB");
		expect(formatBytes(2 * 1024 * 1024)).toBe("2.0 MiB");
	});
});
