import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Directory inside the workspace that holds the journal. */
export const LOG_DIR_NAME = ".pi";

/** Journal file name, written inside {@link LOG_DIR_NAME}. */
export const LOG_FILE_NAME = "tool.log";

/** Severity column recorded for every successful tool call. */
export const LOG_LEVEL = "INFO";

/** Number of trailing lines shown by the `/journal` command. */
export const DEFAULT_TAIL_LINES = 25;

/**
 * Absolute path of the journal for a workspace.
 *
 * @param cwd - Workspace root (`ctx.cwd`)
 * @returns Path to `<cwd>/.pi/tool.log`
 */
export function journalPath(cwd: string): string {
	return join(cwd, LOG_DIR_NAME, LOG_FILE_NAME);
}

/**
 * Append one tab-separated audit record to the workspace journal.
 *
 * The record is written atomically with respect to other in-process writers via
 * pi's file mutation queue, so concurrent agents cannot interleave partial lines.
 * The `.pi` directory is created on first write.
 *
 * @param cwd - Workspace root (`ctx.cwd`)
 * @param tool - Tool name being journalled, e.g. `"edit"`
 * @param targetPath - Path the tool acted on, as supplied by the model
 * @param description - Plain-English rationale supplied with the tool call
 * @returns Resolves once the record has been flushed to disk
 * @throws {@link Error} Propagates filesystem failures to the caller
 */
export async function recordJournalEntry(
	cwd: string,
	tool: string,
	targetPath: string,
	description: string,
): Promise<void> {
	const file = journalPath(cwd);
	const line = `${new Date().toISOString()}\t${LOG_LEVEL}\t${tool}\t${targetPath}\t${description}\n`;

	await mkdir(dirname(file), { recursive: true });
	await withFileMutationQueue(file, async () => {
		await appendFile(file, line);
	});
}

/**
 * Read the most recent journal records.
 *
 * @param cwd - Workspace root (`ctx.cwd`)
 * @param limit - Maximum number of trailing lines to return
 * @returns Trailing journal lines, oldest first; empty when no journal exists yet
 */
export async function readRecentEntries(cwd: string, limit: number = DEFAULT_TAIL_LINES): Promise<string[]> {
	const file = journalPath(cwd);
	let content: string;

	try {
		content = await readFile(file, "utf-8");
	} catch (error) {
		// A workspace that has not journalled yet is an empty history, not a failure.
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return [];
		}
		throw error;
	}

	return content
		.split("\n")
		.filter((line) => line.length > 0)
		.slice(-limit);
}
