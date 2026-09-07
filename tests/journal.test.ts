import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	journalPath,
	LOG_DIR_NAME,
	LOG_FILE_NAME,
	readRecentEntries,
	recordJournalEntry,
} from "../src/utils/journal";

let workspace = "";

beforeEach(async () => {
	workspace = await mkdtemp(join(tmpdir(), "pi-journal-"));
});

afterEach(async () => {
	await rm(workspace, { recursive: true, force: true });
});

/**
 * Read the journal for the temporary workspace.
 *
 * @returns Journal lines, oldest first, trailing newline removed
 */
async function readJournalLines(): Promise<string[]> {
	const content = await readFile(journalPath(workspace), "utf-8");
	return content.split("\n").filter((line) => line.length > 0);
}

describe("recordJournalEntry", () => {
	it("creates the .pi directory and writes one tab-separated record", async () => {
		await recordJournalEntry(workspace, "edit", "src/app.ts", "Rename handler");

		const lines = await readJournalLines();
		expect(lines).toHaveLength(1);

		const [timestamp, level, tool, targetPath, description] = lines[0].split("\t");
		expect(Date.parse(timestamp)).not.toBeNaN();
		expect(level).toBe("INFO");
		expect(tool).toBe("edit");
		expect(targetPath).toBe("src/app.ts");
		expect(description).toBe("Rename handler");
	});

	it("appends instead of overwriting across calls", async () => {
		await recordJournalEntry(workspace, "write", "a.ts", "created a");
		await recordJournalEntry(workspace, "edit", "b.ts", "edited b");

		const lines = await readJournalLines();
		expect(lines).toHaveLength(2);
		expect(lines[0].split("\t")[2]).toBe("write");
		expect(lines[1].split("\t")[2]).toBe("edit");
	});

	it("keeps every record intact when writes run concurrently", async () => {
		await Promise.all(
			Array.from({ length: 10 }, (_unused, index) =>
				recordJournalEntry(workspace, "write", `file-${index}.ts`, `wrote ${index}`),
			),
		);

		const lines = await readJournalLines();
		expect(lines).toHaveLength(10);
		expect(lines.every((line) => line.split("\t").length === 5)).toBe(true);
	});

	it("places the journal at <cwd>/.pi/tool.log", () => {
		expect(journalPath("/work/tree")).toBe(join("/work/tree", LOG_DIR_NAME, LOG_FILE_NAME));
	});
});

describe("readRecentEntries", () => {
	it("returns no entries before the first write", async () => {
		expect(await readRecentEntries(workspace)).toEqual([]);
	});

	it("returns the trailing records, oldest first, honouring the limit", async () => {
		for (let index = 0; index < 5; index += 1) {
			await recordJournalEntry(workspace, "edit", `file-${index}.ts`, `edited ${index}`);
		}

		const entries = await readRecentEntries(workspace, 2);
		expect(entries).toHaveLength(2);
		expect(entries[0].split("\t")[3]).toBe("file-3.ts");
		expect(entries[1].split("\t")[3]).toBe("file-4.ts");
	});
});
