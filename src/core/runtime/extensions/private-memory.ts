import { getCurrentSystemMessage } from "@earendil-works/pi-ai";
import type {
	ContextWithSystemEvent,
	ExtensionFactory,
	SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import { MEMORY_TOOLS } from "../../modules/memory/owner-memory.ts";

type Messages = ContextWithSystemEvent["messages"];

/** What the model reads in place of a result that holds someone else's memory. */
export const HIDDEN_MEMORY = "(another person's private memory, hidden)";
/** What it reads in place of a memory result recorded before results said whose they were. */
export const HIDDEN_UNRECORDED_MEMORY =
	"(a private memory result that does not say whose it is, hidden)";

const MEMORY = new Set<string>(MEMORY_TOOLS);

/** Whether a session with these tools registered loaded someone's memory: its memory tools, and its prompt's section with them. */
export function loadsMemory(registered: ReadonlySet<string>): boolean {
	return MEMORY_TOOLS.some((name) => registered.has(name));
}

/** The principal a result's details say it is private to, if they say. */
function privateTo(details: unknown): string | undefined {
	if (typeof details !== "object" || details === null) return undefined;
	const whose = (details as Record<string, unknown>).privateTo;
	return typeof whose === "string" ? whose : undefined;
}

/** Whose memory a request may carry, and whether its conversation is shared by several people. */
export interface MemoryView {
	shared: boolean;
	/** The principal whose memory the running turn reads; undefined for no one's. */
	reader: string | undefined;
}

type Assistant = Extract<Messages[number], { role: "assistant" }>;

/**
 * An earlier answer without its reasoning, or undefined when it gave none: its thinking, encrypted
 * or not, and the thought signatures of its tool calls, which may carry a person's memory as the
 * turn read it.
 */
function withoutReasoning(message: Assistant): Assistant | undefined {
	let changed = false;
	const content = message.content.flatMap((part): Assistant["content"] => {
		if (part.type === "thinking") {
			changed = true;
			return [];
		}
		if (part.type === "toolCall" && part.thoughtSignature !== undefined) {
			changed = true;
			const { thoughtSignature: _, ...call } = part;
			return [call];
		}
		return [part];
	});
	return changed ? { ...message, content } : undefined;
}

/**
 * The request's messages as the view allows, or undefined when they need no change. A tool result
 * holding someone else's memory reads as a placeholder; in a shared conversation, so does a memory
 * result that does not say whose it is, the answers of the turns before the running one read
 * without their reasoning, and the prompt states its history recorded collapse into one leading
 * message of the current prompt, so no earlier turn's memory section remains.
 */
export function memoryProjection(
	messages: Messages,
	view: MemoryView,
): Messages | undefined {
	// The running turn starts at the last message someone wrote; its own reasoning stays its own.
	const running = view.shared
		? messages.findLastIndex((message) => message.role === "user")
		: -1;
	let changed = false;
	const shown = messages.map((message, index) => {
		const projected = projectedMessage(message, view, index < running);
		if (!projected) return message;
		changed = true;
		return projected;
	});
	const prompts = shown.filter((message) => message.role === "system").length;
	if (!view.shared || prompts <= 1) return changed ? shown : undefined;
	const head = getCurrentSystemMessage(shown);
	if (!head) return changed ? shown : undefined;
	return [head, ...shown.filter((message) => message.role !== "system")];
}

/** One message as the view allows, or undefined when it needs no change. */
function projectedMessage(
	message: Messages[number],
	view: MemoryView,
	earlier: boolean,
): Messages[number] | undefined {
	if (message.role === "assistant")
		return earlier ? withoutReasoning(message) : undefined;
	if (message.role !== "toolResult") return undefined;
	const whose = privateTo(message.details);
	const hidden =
		whose !== undefined
			? whose !== view.reader && HIDDEN_MEMORY
			: view.shared &&
				MEMORY.has(message.toolName) &&
				!message.isError &&
				HIDDEN_UNRECORDED_MEMORY;
	if (!hidden) return undefined;
	return { ...message, content: [{ type: "text" as const, text: hidden }] };
}

/**
 * What a shared conversation's compaction may summarize of its history: as no one's turn reads it,
 * without the prompt states, whose memory sections are someone's, and without reasoning, which may
 * restate the memory its turn read. A summary outlives the turns it covers and every later speaker
 * reads it, so it is written from no one's memory.
 */
export function summaryProjection(
	messages: ContextWithSystemEvent["messages"],
): ContextWithSystemEvent["messages"] {
	const view: MemoryView = { shared: true, reader: undefined };
	return messages.flatMap((message) =>
		message.role === "system"
			? []
			: [projectedMessage(message, view, true) ?? message],
	);
}

/**
 * Has a shared conversation's compaction summarize its history as `summaryProjection` gives it.
 * Pi hands every `session_before_compact` handler, and its own summary after them, the same
 * preparation, so each that reads it later reads the projection.
 */
export function privateCompaction(
	preparation: SessionBeforeCompactEvent["preparation"],
): void {
	preparation.messagesToSummarize = summaryProjection(
		preparation.messagesToSummarize,
	);
	preparation.turnPrefixMessages = summaryProjection(
		preparation.turnPrefixMessages,
	);
}

/**
 * The tool calls a session runs at once, and those of them that drew on the reader's memory while
 * they ran, such as one whose task's worker read it: their results hold that memory too.
 */
export class MemoryDraws {
	readonly #running = new Set<string>();
	readonly #drawn = new Set<string>();

	/** Every call running now draws on the reader's memory: something it started read it. */
	drawn(): void {
		for (const id of this.#running) this.#drawn.add(id);
	}

	start(toolCallId: string): void {
		this.#running.add(toolCallId);
	}

	/** Whether the call drew on the reader's memory; it is forgotten, as it ended. */
	end(toolCallId: string): boolean {
		this.#running.delete(toolCallId);
		return this.#drawn.delete(toolCallId);
	}
}

/**
 * Projects each model request of a session so it carries no one's memory but the running turn's
 * reader's: a person's memory is theirs per request, never the history's to share. A tool result
 * that drew on the reader's memory, nested calls' and tasks' included, records it as theirs, as a
 * memory tool's does. A shared conversation's compaction summarizes no one's memory.
 */
export function privateMemoryExtension(
	shared: boolean,
	reader: () => string | undefined,
	draws: MemoryDraws,
): ExtensionFactory {
	return (pi) => {
		pi.on("tool_execution_start", (event) => {
			draws.start(event.toolCallId);
		});
		pi.on("tool_result", (event) => {
			if (!draws.end(event.toolCallId)) return undefined;
			const whose = reader();
			if (whose === undefined) return undefined;
			const details = "details" in event ? event.details : undefined;
			return {
				details: {
					...(typeof details === "object" && details !== null ? details : {}),
					privateTo: whose,
				},
			};
		});
		// The compaction extension placed through the core's wrapper got the projection already; Pi's
		// own summary, which runs when no extension answers, reads it from here.
		if (shared)
			pi.on("session_before_compact", (event) => {
				privateCompaction(event.preparation);
			});
		pi.on("context_with_system", (event) => {
			const messages = memoryProjection(event.messages, {
				shared,
				reader: reader(),
			});
			return messages ? { messages } : undefined;
		});
	};
}
