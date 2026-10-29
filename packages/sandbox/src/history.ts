/**
 * The conversation history file the sealed worker reads and writes, one per channel: a JSON array
 * of at most 20 `{ role, content }` entries, oldest first. A host that writes history before a
 * channel's first turn, such as an import of old chats, uses this encoder so the worker accepts it.
 */
export const HISTORY_FILE = "history.json";
/** The most entries a history file holds; the worker keeps the last 20 after each turn. */
export const HISTORY_MAX_ENTRIES = 20;
/** The most bytes one entry's `content` may take, measured as `Buffer.byteLength(JSON.stringify(content))`. */
export const HISTORY_ENTRY_BYTES = 8192;

export interface SandboxHistoryEntry {
	role: "user" | "assistant";
	content: string;
}

/**
 * The `content` of a user entry: the JSON text new turns write, naming who spoke and what they
 * said. The speaker's `id` and `name` are the surface's own, as the worker is told them.
 */
export function userHistoryContent(
	speaker: { id: string; name: string },
	message: string,
): string {
	return JSON.stringify({ speaker, message });
}

/**
 * The text of a history file for `entries`, refusing what the worker would: more than 20
 * entries, a role other than user or assistant, or content over 8,192 bytes. Write it with mode
 * 0600 into the channel's directory (see `historyFilePath`).
 */
export function encodeHistory(entries: readonly SandboxHistoryEntry[]): string {
	if (entries.length > HISTORY_MAX_ENTRIES)
		throw new Error(`history holds at most ${HISTORY_MAX_ENTRIES} entries`);
	for (const entry of entries) {
		if (
			typeof entry !== "object" ||
			entry === null ||
			(entry.role !== "user" && entry.role !== "assistant") ||
			typeof entry.content !== "string"
		)
			throw new Error("a history entry is { role: user | assistant, content }");
		if (Buffer.byteLength(JSON.stringify(entry.content)) > HISTORY_ENTRY_BYTES)
			throw new Error(
				`a history entry's content is over ${HISTORY_ENTRY_BYTES} bytes`,
			);
	}
	return JSON.stringify(
		entries.map(({ role, content }) => ({ role, content })),
	);
}
