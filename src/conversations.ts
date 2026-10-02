import {
	closeSync,
	existsSync,
	fstatSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	statSync,
} from "node:fs";
import { join } from "node:path";
import type { ChannelKey } from "pi-roundtable";
import { textOf } from "pi-roundtable/kit";
import type { TranscriptEntry } from "./api-types.ts";

const FIRST_MESSAGE_CHARS = 80;
/** The most a transcript request reads from disk, newest files first. */
const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024;
/** The most entries a transcript returns; the oldest are dropped. */
const MAX_ENTRIES = 1000;
const MAX_TEXT_CHARS = 20_000;
const MAX_TOOL_TEXT_CHARS = 2000;
const MAX_PREVIEW_CHARS = 200;

const DISCORD_DIR = /^discord_(\d{17,20})$/;
const MCP_DIR =
	/^mcp_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const DISCORD_KEY = /^discord:(\d{17,20})$/;
const MCP_KEY =
	/^mcp:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/** Facts about a conversation's files. */
export interface ConversationFiles {
	/** Bytes of the live conversation; 0 when only archives are left. */
	liveBytes: number;
	archives: number;
	lastActive?: string;
}

/** An owner, agent, or outside-agent conversation found on disk. */
export interface StoredConversation extends ConversationFiles {
	key: ChannelKey;
	kind: "discord" | "mcp";
	/** The Discord channel id, or the outside agent's session id. */
	id: string;
	/** Outside-agent conversations only. */
	firstMessage?: string;
	startedAt?: string;
}

/** The session directory a channel key names, or undefined when the key is not one the console reads. */
export function parseKey(
	key: string,
): { dir: string; kind: "discord" | "mcp"; id: string } | undefined {
	const discord = DISCORD_KEY.exec(key)?.[1];
	if (discord)
		return { dir: `discord_${discord}`, kind: "discord", id: discord };
	const mcp = MCP_KEY.exec(key)?.[1];
	if (mcp) return { dir: `mcp_${mcp}`, kind: "mcp", id: mcp };
	return undefined;
}

/**
 * The live `.jsonl` files at a session directory's top level and its `archive/<time>/`
 * folders, as `archiveSessions` leaves them. Undefined when the directory does not exist.
 */
export function conversationFiles(dir: string): ConversationFiles | undefined {
	if (!existsSync(dir)) return undefined;
	let liveBytes = 0;
	let newest = 0;
	for (const file of readdirSync(dir)) {
		if (!file.endsWith(".jsonl")) continue;
		const stat = statSync(join(dir, file));
		liveBytes += stat.size;
		newest = Math.max(newest, stat.mtimeMs);
	}
	const archiveDir = join(dir, "archive");
	const archives = existsSync(archiveDir)
		? readdirSync(archiveDir, { withFileTypes: true }).filter((entry) =>
				entry.isDirectory(),
			)
		: [];
	if (newest === 0)
		for (const archive of archives)
			newest = Math.max(
				newest,
				statSync(join(archiveDir, archive.name)).mtimeMs,
			);
	return {
		liveBytes,
		archives: archives.length,
		...(newest > 0 ? { lastActive: new Date(newest).toISOString() } : {}),
	};
}

interface SessionLine {
	type?: unknown;
	timestamp?: unknown;
	summary?: unknown;
	message?: {
		role?: unknown;
		content?: unknown;
		toolName?: unknown;
		isError?: unknown;
	};
}

const clip = (text: string, limit: number): string =>
	text.length > limit ? `${text.slice(0, limit - 1)}…` : text;

/** The text after a relay note, when the message starts with one of them. */
function withoutRelayNote(text: string, notes: readonly string[]): string {
	const note = notes.find((prefix) => prefix && text.startsWith(prefix));
	return (note ? text.slice(note.length) : text).trim();
}

/** The `.jsonl` file names directly in a directory, oldest first; names start with their creation time. */
function sessionFiles(dir: string): string[] {
	return readdirSync(dir)
		.filter((file) => file.endsWith(".jsonl"))
		.sort();
}

/**
 * When the conversation started and its first user message, relay notes removed: from the
 * live conversation, or from the oldest archive once it has been started over.
 */
function opening(
	dir: string,
	relayNotes: readonly string[],
): { firstMessage?: string; startedAt?: string } {
	const archiveDir = join(dir, "archive");
	const first = sessionFiles(dir)[0];
	let file = first ? join(dir, first) : undefined;
	if (!file && existsSync(archiveDir))
		for (const archive of readdirSync(archiveDir).sort()) {
			const name = sessionFiles(join(archiveDir, archive))[0];
			if (name) {
				file = join(archiveDir, archive, name);
				break;
			}
		}
	if (!file) return {};
	const result: { firstMessage?: string; startedAt?: string } = {};
	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (!line.trim()) continue;
		let entry: SessionLine;
		try {
			entry = JSON.parse(line);
		} catch {
			// A line cut off mid-write ends what can be read.
			break;
		}
		if (entry.type === "session" && typeof entry.timestamp === "string")
			result.startedAt = entry.timestamp;
		if (entry.type === "message" && entry.message?.role === "user") {
			result.firstMessage = clip(
				withoutRelayNote(textOf(entry.message.content), relayNotes),
				FIRST_MESSAGE_CHARS,
			);
			break;
		}
	}
	return result;
}

/**
 * Agent, owner, and outside-agent conversations (`discord_<channel>`, `mcp_<session>`) under
 * the host's `sessions/` directory, minus the channels `excluded` claims.
 */
export function storedConversations(
	sessionsDir: string,
	options: {
		excluded: (key: ChannelKey) => boolean;
		relayNotes: readonly string[];
	},
): StoredConversation[] {
	if (!existsSync(sessionsDir)) return [];
	const found: StoredConversation[] = [];
	for (const entry of readdirSync(sessionsDir, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const discord = DISCORD_DIR.exec(entry.name)?.[1];
		const mcp = MCP_DIR.exec(entry.name)?.[1];
		const id = discord ?? mcp;
		if (!id) continue;
		const key: ChannelKey = discord ? `discord:${id}` : `mcp:${id}`;
		if (options.excluded(key)) continue;
		const dir = join(sessionsDir, entry.name);
		const files = conversationFiles(dir);
		if (!files) continue;
		found.push({
			key,
			kind: discord ? "discord" : "mcp",
			id,
			...files,
			...(mcp ? opening(dir, options.relayNotes) : {}),
		});
	}
	return found.sort((a, b) =>
		(b.lastActive ?? "").localeCompare(a.lastActive ?? ""),
	);
}

/** The archive folders of a conversation, newest first. */
export function archiveNames(dir: string): string[] {
	const archiveDir = join(dir, "archive");
	if (!existsSync(archiveDir)) return [];
	return readdirSync(archiveDir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort()
		.reverse();
}

/** The last `limit` bytes of a file as text, from the first whole line when the file is longer. */
function readTail(path: string, limit: number): { text: string; cut: boolean } {
	const fd = openSync(path, "r");
	try {
		const { size } = fstatSync(fd);
		if (size <= limit) return { text: readFileSync(fd, "utf8"), cut: false };
		const buffer = Buffer.alloc(limit);
		readSync(fd, buffer, 0, limit, size - limit);
		const text = buffer.toString("utf8");
		return { text: text.slice(text.indexOf("\n") + 1), cut: true };
	} finally {
		closeSync(fd);
	}
}

function callPreview(args: unknown): string {
	try {
		return clip(JSON.stringify(args) ?? "", MAX_PREVIEW_CHARS);
	} catch {
		return "";
	}
}

/** One session line as a transcript entry; undefined for lines the console does not show. */
function entryOf(
	line: SessionLine,
	relayNotes: readonly string[],
): TranscriptEntry | undefined {
	const at = typeof line.timestamp === "string" ? line.timestamp : undefined;
	const base = at ? { at } : {};
	if (line.type === "compaction" && typeof line.summary === "string")
		return {
			role: "compaction",
			...base,
			text: clip(line.summary, MAX_TOOL_TEXT_CHARS),
		};
	if (line.type !== "message" || !line.message) return undefined;
	const { role, content } = line.message;
	if (role === "user") {
		const text = withoutRelayNote(textOf(content), relayNotes);
		return text
			? { role: "user", ...base, text: clip(text, MAX_TEXT_CHARS) }
			: undefined;
	}
	if (role === "assistant") {
		const text = textOf(content).trim();
		const calls = Array.isArray(content)
			? content.flatMap((part) =>
					part?.type === "toolCall" && typeof part.name === "string"
						? [{ name: part.name, preview: callPreview(part.arguments) }]
						: [],
				)
			: [];
		if (!text && calls.length === 0) return undefined;
		return {
			role: "assistant",
			...base,
			text: clip(text, MAX_TEXT_CHARS),
			...(calls.length > 0 ? { calls } : {}),
		};
	}
	if (role === "toolResult")
		return {
			role: "tool",
			...base,
			text: clip(textOf(content), MAX_TOOL_TEXT_CHARS),
			...(typeof line.message.toolName === "string"
				? { tool: line.message.toolName }
				: {}),
			...(line.message.isError === true ? { failed: true } : {}),
		};
	return undefined;
}

/**
 * The entries of a conversation's live files, or of one archive, oldest first. Reads newest
 * files first until the byte budget is spent, so a very long conversation shows its end.
 */
export function readTranscript(
	dir: string,
	archive: string | undefined,
	relayNotes: readonly string[],
): { entries: TranscriptEntry[]; truncated: boolean } {
	const folder = archive ? join(dir, "archive", archive) : dir;
	const files = sessionFiles(folder).reverse();
	let budget = MAX_TRANSCRIPT_BYTES;
	let truncated = false;
	const chunks: TranscriptEntry[][] = [];
	for (const file of files) {
		if (budget <= 0) {
			truncated = true;
			break;
		}
		const { text, cut } = readTail(join(folder, file), budget);
		budget -= Buffer.byteLength(text);
		if (cut) truncated = true;
		const entries: TranscriptEntry[] = [];
		for (const raw of text.split("\n")) {
			if (!raw.trim()) continue;
			let line: SessionLine;
			try {
				line = JSON.parse(raw);
			} catch {
				// A line cut off mid-write has no entry.
				continue;
			}
			const entry = entryOf(line, relayNotes);
			if (entry) entries.push(entry);
		}
		chunks.push(entries);
	}
	const all = chunks.reverse().flat();
	if (all.length > MAX_ENTRIES) truncated = true;
	return { entries: all.slice(-MAX_ENTRIES), truncated };
}
