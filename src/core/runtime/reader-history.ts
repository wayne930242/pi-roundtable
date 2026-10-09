import type {
	ContextWithSystemEvent,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { SYSTEM_PRINCIPAL } from "../identity/principal-store.ts";
import { MEMORY_TOOLS } from "../modules/memory/owner-memory.ts";
import { guardHidesPrivateExchange } from "./extensions/private-memory.ts";
import { SCOPE_ENTRY } from "./session-scope.ts";

/** A turn's reader and whether its request carried private memory, retained across compaction. */
export const MEMORY_TURN_ENTRY = "roundtable-memory-turn";
interface ReaderRecord {
	reader: string;
	privateMemory: boolean;
}
type Messages = ContextWithSystemEvent["messages"];
const MEMORY = new Set<string>(MEMORY_TOOLS);

/** Persist before prompting; the returned marker records later memory exchanges or memory-loaded workers. */
export function recordMemoryTurn(
	manager: Pick<SessionManager, "appendCustomEntry">,
	reader: string,
	privateMemory: boolean,
): () => void {
	const turnId = crypto.randomUUID();
	manager.appendCustomEntry(MEMORY_TURN_ENTRY, {
		turnId,
		reader,
		privateMemory,
	});
	return () => {
		if (privateMemory) return;
		privateMemory = true;
		manager.appendCustomEntry(MEMORY_TURN_ENTRY, {
			turnId,
			reader,
			privateMemory,
		});
	};
}

/** Includes immediate validation/truncation failures and calls an aborted turn left unanswered. */
export function carriesMemory(message: Messages[number]): boolean {
	if (message.role === "assistant")
		return message.content.some(
			(part) => part.type === "toolCall" && MEMORY.has(part.name),
		);
	if (message.role !== "toolResult") return false;
	return (
		MEMORY.has(message.toolName) ||
		(typeof message.details === "object" &&
			message.details !== null &&
			"privateTo" in message.details)
	);
}

function readerRecord(data: unknown): ReaderRecord | undefined {
	if (typeof data !== "object" || data === null) return undefined;
	if (
		!("reader" in data) ||
		!("privateMemory" in data) ||
		typeof data.reader !== "string" ||
		data.reader.length === 0 ||
		typeof data.privateMemory !== "boolean"
	)
		return undefined;
	return { reader: data.reader, privateMemory: data.privateMemory };
}

/**
 * Whether bridge's raw branch would replay another reader's private turn, including retained
 * prompts/reasoning and compacted entries. Explicit privateTo results still restrict the reader.
 * Untagged memory before the first scope record keeps the primary-owner legacy attribution;
 * later unrecorded exchanges fail closed. SYSTEM counts as primary owner only when supplied.
 */
export function bridgeHistoryHidesMemory(
	branch: ReturnType<SessionManager["getBranch"]>,
	reader: string | undefined,
	primaryOwner?: string,
): boolean {
	const normalized = (who: string | undefined) =>
		who === SYSTEM_PRINCIPAL && primaryOwner !== undefined ? primaryOwner : who;
	const current = normalized(reader);
	let record: ReaderRecord | undefined;
	let messages: Messages = [];
	let legacy = true;
	const hidden = () => {
		const whose = normalized(record?.reader);
		const carried = record?.privateMemory || messages.some(carriesMemory);
		if (record && carried && whose !== current) return true;
		return guardHidesPrivateExchange(messages, {
			shared: true,
			reader: current,
			legacyOwner: record ? whose : legacy ? primaryOwner : undefined,
			turnReader: whose,
		});
	};
	for (const entry of branch) {
		if (
			entry.type === "custom" &&
			(entry.customType === MEMORY_TURN_ENTRY ||
				entry.customType === SCOPE_ENTRY)
		) {
			if (hidden()) return true;
			messages = [];
			if (entry.customType === SCOPE_ENTRY) legacy = false;
			else {
				record = readerRecord(entry.data);
				// A corrupt record cannot establish safe ownership of a private turn.
				if (!record) return true;
			}
		} else if (entry.type === "message") messages.push(entry.message);
	}
	return hidden();
}
