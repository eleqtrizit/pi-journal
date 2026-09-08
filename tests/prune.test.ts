import { describe, expect, it } from "vitest";
import { pruneFailedToolResults } from "../src/utils/prune";

type AgentMessage = Parameters<typeof pruneFailedToolResults>[0][number];
type AssistantMessage = Extract<AgentMessage, { role: "assistant" }>;
type ToolResultMessage = Extract<AgentMessage, { role: "toolResult" }>;

const ZERO_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-test",
		usage: ZERO_USAGE,
		stopReason: "toolUse",
		timestamp: Date.parse("2026-03-04T09:00:00Z"),
	};
}

function toolResult(toolName: string, text: string, isError = false, toolCallId = `${toolName}-1`): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text }],
		isError,
		timestamp: Date.parse("2026-03-04T09:00:01Z"),
	};
}

function call(name: string, args: Record<string, unknown>, id = `${name}-1`): Extract<AssistantMessage["content"][number], { type: "toolCall" }> {
	return { type: "toolCall", id, name, arguments: args };
}

describe("pruneFailedToolResults", () => {
	it("passes through a context with no failed file-tool results", () => {
		const messages = [
			assistant([{ type: "text", text: "hello" }]),
			toolResult("edit", "edited src/a.ts"),
			toolResult("read", "contents…"),
			toolResult("bash", "boom", true),
		];
		const { messages: pruned, stats } = pruneFailedToolResults(messages);

		expect(stats.ejected).toBe(0);
		expect(pruned).toEqual(messages);
		expect(pruned[3]).toBe(messages[3]); // failed bash result untouched
	});

	it("replaces failed edit/read/write results with stubs, keeping pairing", () => {
		const messages = [
			assistant([call("edit", { path: "src/a.ts", description: "x" }, "edit-1"), call("read", { path: "src/b.ts" }, "read-1")]),
			toolResult("edit", "oldText not found:\n...400 lines...", true, "edit-1"),
			toolResult("read", "stack trace\n".repeat(50), true, "read-1"),
		];
		const { messages: pruned, stats } = pruneFailedToolResults(messages, { keepRecent: 0 });

		expect(stats.ejected).toBe(2);
		expect(pruned).toHaveLength(3); // pairing preserved
		const editResult = pruned[1] as ToolResultMessage;
		const readResult = pruned[2] as ToolResultMessage;
		const editText = editResult.content.filter((item): item is { type: "text"; text: string } => item.type === "text")[0];
		const readText = readResult.content.filter((item): item is { type: "text"; text: string } => item.type === "text")[0];
		expect(editText?.text).toBe("[error pruned] edit src/a.ts failed: oldText not found: ...400 lines...");
		expect(editResult.isError).toBe(true);
		expect(editResult.toolCallId).toBe("edit-1");
		expect(readText?.text).toContain("stack trace");
		expect(readText?.text.length).toBeLessThan(250);
	});

	it("keeps successful results verbatim and does not mutate the input", () => {
		const ok = toolResult("write", "wrote file");
		const failed = toolResult("write", "EACCES: permission denied", true);
		const messages = [assistant([call("write", { path: "src/c.ts" })]), ok, failed];
		const { messages: pruned, stats } = pruneFailedToolResults(messages, { keepRecent: 0 });

		expect(stats.ejected).toBe(1);
		expect(pruned[1]).toBe(ok);
		const failedAsStored = messages[2] as ToolResultMessage;
		expect((failedAsStored.content[0] as { text: string }).text).toBe("EACCES: permission denied"); // input untouched
	});

	it("caps stub error text at 200 characters", () => {
		const messages = [
			assistant([call("read", { path: "src/big.ts" })]),
			toolResult("read", "x".repeat(1000), true),
		];
		const { messages: pruned } = pruneFailedToolResults(messages, { keepRecent: 0 });
		const text = (pruned[1] as ToolResultMessage).content.filter(
			(item): item is { type: "text"; text: string } => item.type === "text",
		)[0];
		expect(text?.text).toBe(`[error pruned] read src/big.ts failed: ${"x".repeat(200)}`);
	});

	it("keeps failed results inside the shared window of 10 journalled results (default)", () => {
		const messages: AgentMessage[] = [];
		// A failure followed by 10 newer journalled results: outside the 10-result window → stubbed.
		messages.push(assistant([call("read", { path: "late.ts" }, "late")]));
		messages.push(toolResult("read", "error late", true, "late"));
		for (let index = 0; index < 10; index += 1) {
			messages.push(assistant([call("read", { path: `ok${index}.ts` }, `ok${index}`)]));
			messages.push(toolResult("read", `contents ${index}`, false, `ok${index}`));
		}
		const first = pruneFailedToolResults(messages);
		expect(first.stats).toEqual({ ejected: 1, kept: 0 });

		// The same failure followed by only 9 newer results: inside the window → kept.
		for (let index = 0; index < 9; index += 1) {
			messages.pop(); // drop the 10th success pair
		}
		const second = pruneFailedToolResults(messages);
		expect(second.stats).toEqual({ ejected: 0, kept: 1 });
		expect(second.messages.at(-1)).toBe(messages.at(-1)); // verbatim, same object
	});

	it("counts results of any tool toward the keep window", () => {
		const messages: AgentMessage[] = [
			assistant([call("edit", { path: "src/a.ts" }, "e1")]),
			toolResult("edit", "boom", true, "e1"),
		];
		for (let index = 0; index < 10; index += 1) {
			messages.push(assistant([call("bash", { command: `cmd ${index}` }, `b${index}`)]));
			messages.push(toolResult("bash", `output ${index}`, false, `b${index}`));
		}
		const { messages: pruned, stats } = pruneFailedToolResults(messages);

		// 10 newer bash results fill the window entirely; the failed edit is stubbed.
		expect(stats.ejected).toBe(1);
		expect(stats.kept).toBe(0);
		const edit = pruned[1] as ToolResultMessage;
		expect((edit.content[0] as { text: string }).text).toContain("[error pruned] edit src/a.ts");
	});
});
