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
	/** Bridge guard only: pre-attribution built-in memory results belong to this owner. */
	legacyOwner?: string;
}

type Assistant = Extract<Messages[number], { role: "assistant" }>;

/**
 * The apis whose signature on an answer's text names the message it was, its id and phase, rather
 * than reasoning: OpenAI's Responses, which every other api's signed text is not. Gemini signs a
 * text part with the thought signature of the reasoning behind it, and its converter sends it back.
 */
const MESSAGE_SIGNED = new Set([
	"openai-responses",
	"azure-openai-responses",
	"openai-codex-responses",
]);

/**
 * Whether the answer's replayed items were paired with reasoning it replays: OpenAI's Responses
 * pairs the ids of a response's message and calls with its reasoning item, and refuses a replay
 * that carries the ids without that item.
 */
function pairsReplay(message: Assistant): boolean {
	return (
		MESSAGE_SIGNED.has(message.api) &&
		message.content.some((part) => part.type === "thinking")
	);
}

/** A call's id without the item id OpenAI's Responses paired with its reasoning: `call|fc_…` reads `call`. */
const unpairedCallId = (id: string): string => id.split("|")[0] ?? id;

/** A message's signature without its item id, keeping its phase; undefined when it had none. */
function unpairedSignature(signature: string): string | undefined {
	try {
		const parsed: unknown = JSON.parse(signature);
		const phase =
			typeof parsed === "object" && parsed !== null && "phase" in parsed
				? parsed.phase
				: undefined;
		return typeof phase === "string"
			? JSON.stringify({ v: 1, id: "", phase })
			: undefined;
	} catch {
		return undefined;
	}
}

/**
 * An earlier answer without its reasoning, or undefined when it gave none: its thinking, encrypted
 * or not, the thought signatures of its tool calls, and those its provider signed its text with,
 * which may carry a person's memory as the turn read it. Where OpenAI's Responses paired the
 * answer's message and call ids with that reasoning, they go with it; each call keeps the id its
 * result answers, and each message its phase.
 */
function withoutReasoning(message: Assistant): Assistant | undefined {
	const signsReasoning = !MESSAGE_SIGNED.has(message.api);
	const unpair = pairsReplay(message);
	let changed = false;
	const content = message.content.flatMap((part): Assistant["content"] => {
		if (part.type === "thinking") {
			changed = true;
			return [];
		}
		if (part.type === "toolCall") {
			const { thoughtSignature, ...call } = part;
			const id = unpair ? unpairedCallId(part.id) : part.id;
			if (thoughtSignature === undefined && id === part.id) return [part];
			changed = true;
			return [{ ...call, id }];
		}
		if (
			part.type === "text" &&
			part.textSignature !== undefined &&
			(signsReasoning || unpair)
		) {
			changed = true;
			const { textSignature, ...text } = part;
			const kept = signsReasoning
				? undefined
				: unpairedSignature(textSignature);
			return [kept === undefined ? text : { ...text, textSignature: kept }];
		}
		return [part];
	});
	return changed ? { ...message, content } : undefined;
}

/** The ids of the earlier answers' calls whose reasoning goes, and their pairing with it. */
function unpairedCalls(messages: Messages, before: number): Set<string> {
	const ids = new Set<string>();
	for (const message of messages.slice(0, Math.max(before, 0)))
		if (message.role === "assistant" && pairsReplay(message))
			for (const part of message.content)
				if (part.type === "toolCall") ids.add(part.id);
	return ids;
}

/** Whether raw history contains a private exchange this view would hide (not reasoning/prompt changes). */
export function hidesPrivateExchange(
	messages: ContextWithSystemEvent["messages"],
	view: MemoryView,
): boolean {
	return hiddenExchanges(messages, view).size > 0;
}

/**
 * The request's messages as the view allows, or undefined when they need no change. A private
 * exchange reads as a placeholder for other readers, its call's arguments as well as its result.
 * In shared history unowned built-in memory calls are hidden too, earlier reasoning is removed,
 * and persisted prompt states collapse to the current prompt alone.
 */
export function memoryProjection(
	messages: ContextWithSystemEvent["messages"],
	view: MemoryView,
): ContextWithSystemEvent["messages"] | undefined {
	// The running turn starts at the last message someone wrote; its own reasoning stays its own.
	const running = view.shared
		? messages.findLastIndex((message) => message.role === "user")
		: -1;
	const hidden = hiddenExchanges(messages, view);
	const unpaired = unpairedCalls(messages, running);
	let changed = false;
	const shown = messages.map((message, index) => {
		const projected = projectedMessage(message, {
			hidden,
			unpaired,
			earlier: index < running,
		});
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

type ToolResult = Extract<Messages[number], { role: "toolResult" }>;

/** What a result reads as in the view when it holds memory the view may not show; undefined when it shows. */
function hiddenResult(
	result: ToolResult,
	view: MemoryView,
): string | undefined {
	const whose = privateTo(result.details);
	if (whose !== undefined)
		return whose === view.reader ? undefined : HIDDEN_MEMORY;
	// A failed exchange too: its call's arguments are what the model wrote from someone's memory.
	if (!view.shared || !MEMORY.has(result.toolName)) return undefined;
	if (view.legacyOwner !== undefined && view.reader === view.legacyOwner)
		return undefined;
	return HIDDEN_UNRECORDED_MEMORY;
}

/**
 * The exchanges the view hides, by their call's id, and what each reads as: those whose result
 * holds memory it may not show, and, in a shared conversation, a memory call no result answers,
 * such as one a stopped turn left, which says nothing of whose memory it wrote.
 */
function hiddenExchanges(
	messages: Messages,
	view: MemoryView,
): Map<string, string> {
	const hidden = new Map<string, string>();
	const answered = new Set<string>();
	for (const message of messages) {
		if (message.role !== "toolResult") continue;
		answered.add(message.toolCallId);
		const text = hiddenResult(message, view);
		if (text) hidden.set(message.toolCallId, text);
	}
	if (!view.shared) return hidden;
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const part of message.content)
			if (
				part.type === "toolCall" &&
				MEMORY.has(part.name) &&
				!answered.has(part.id)
			)
				hidden.set(part.id, HIDDEN_UNRECORDED_MEMORY);
	}
	return hidden;
}

/**
 * An answer whose hidden calls read with placeholder arguments, or undefined when it has none.
 * Each stays a call by its id and name, as every provider expects of a call its result answers.
 */
function withHiddenCalls(
	message: Assistant,
	hidden: ReadonlyMap<string, string>,
): Assistant | undefined {
	let changed = false;
	const content = message.content.map((part) => {
		if (part.type !== "toolCall") return part;
		const text = hidden.get(part.id);
		if (text === undefined) return part;
		changed = true;
		const { thoughtSignature: _, ...call } = part;
		return { ...call, arguments: { hidden: text } };
	});
	return changed ? { ...message, content } : undefined;
}

/** What a message's projection hides, and whether it is of a turn before the running one. */
interface Projection {
	/** The hidden exchanges' placeholders, by their call's original id. */
	hidden: ReadonlyMap<string, string>;
	/** The calls whose replay pairing goes with their answer's reasoning, by their original id. */
	unpaired: ReadonlySet<string>;
	earlier: boolean;
}

/** One message as the projection allows, or undefined when it needs no change. */
function projectedMessage(
	message: Messages[number],
	{ hidden, unpaired, earlier }: Projection,
): Messages[number] | undefined {
	if (message.role === "assistant") {
		const shown = withHiddenCalls(message, hidden);
		const reasoned = earlier ? withoutReasoning(shown ?? message) : undefined;
		return reasoned ?? shown;
	}
	if (message.role !== "toolResult") return undefined;
	const text = hidden.get(message.toolCallId);
	const id = unpaired.has(message.toolCallId)
		? unpairedCallId(message.toolCallId)
		: message.toolCallId;
	if (text === undefined && id === message.toolCallId) return undefined;
	const owner = privateTo(message);
	return {
		...message,
		toolCallId: id,
		...(text === undefined
			? {}
			: {
					content: [{ type: "text" as const, text }],
					details: owner ? { privateTo: owner } : undefined,
					nestedCalls: undefined,
				}),
	};
}

/**
 * What a shared conversation's compaction may summarize of its history: as no one's turn reads it,
 * without the prompt states, whose memory sections are someone's, and without reasoning, which may
 * restate the memory its turn read. A summary outlives the turns it covers and every later speaker
 * reads it, so it is written from no one's memory.
 */
export function summaryProjection(
	messages: ContextWithSystemEvent["messages"],
	/** Full exchange history when calls/results straddle a compaction boundary. */
	history: ContextWithSystemEvent["messages"] = messages,
): ContextWithSystemEvent["messages"] {
	const projection: Projection = {
		hidden: hiddenExchanges(history, { shared: true, reader: undefined }),
		unpaired: unpairedCalls(history, history.length),
		earlier: true,
	};
	return messages.flatMap((message) =>
		message.role === "system"
			? []
			: [projectedMessage(message, projection) ?? message],
	);
}

/**
 * Has a shared conversation's compaction summarize its history as `summaryProjection` gives it.
 * Pi hands every `session_before_compact` handler, and its own summary after them, the same
 * preparation, so each that reads it later reads the projection.
 */
export function privateCompaction(
	preparation: SessionBeforeCompactEvent["preparation"],
	/** Messages also handed to a custom compactor, such as the kept tail. */
	additionalMessages: ContextWithSystemEvent["messages"] = [],
): void {
	const history = [
		...preparation.messagesToSummarize,
		...preparation.turnPrefixMessages,
		...additionalMessages,
	];
	preparation.messagesToSummarize = summaryProjection(
		preparation.messagesToSummarize,
		history,
	);
	preparation.turnPrefixMessages = summaryProjection(
		preparation.turnPrefixMessages,
		history,
	);
}

/**
 * The tool calls a session runs at once, and those of them that drew on the reader's memory while
 * they ran, such as one whose task's worker read it: their results hold that memory too.
 */
export class MemoryDraws {
	readonly #running = new Set<string>();
	/** The call each running call was made by, when another tool made it. */
	readonly #parents = new Map<string, string>();
	readonly #drawn = new Set<string>();

	/**
	 * Something run within these calls, outermost first, read the reader's memory: the calls of
	 * this session among them draw on it, and so do the calls that made them. Called from outside
	 * every call of this session, it cannot say whose, so every call running now draws on it.
	 */
	drawn(within: readonly string[]): void {
		const own = within.filter((id) => this.#running.has(id));
		if (own.length === 0) {
			for (const id of this.#running) this.#drawn.add(id);
			return;
		}
		for (const id of own)
			for (
				let at: string | undefined = id;
				at !== undefined && this.#running.has(at);
				at = this.#parents.get(at)
			)
				this.#drawn.add(at);
	}

	start(toolCallId: string, parentToolCallId?: string): void {
		this.#running.add(toolCallId);
		if (parentToolCallId !== undefined)
			this.#parents.set(toolCallId, parentToolCallId);
	}

	/** Whether the call drew on the reader's memory; it is forgotten, as it ended. */
	end(toolCallId: string): boolean {
		this.#running.delete(toolCallId);
		this.#parents.delete(toolCallId);
		return this.#drawn.delete(toolCallId);
	}
}

/**
 * Projects each model request of a session so it carries no one's memory but the running turn's
 * reader's: a person's memory is theirs per request, never the history's to share. A tool result
 * that drew on the reader's memory, the call whose task's worker read it and the calls that call
 * runs within, records it as theirs, as a memory tool's does; a call merely running beside it does
 * not. A shared conversation's compaction summarizes no one's memory.
 *
 * What it guarantees in a shared conversation: a memory exchange, a memory tool's call and result
 * or a call whose task's worker loaded the reader's memory and its result, paired by the call's id,
 * reaches neither another speaker's request, the host's own turns included, nor a summary: the
 * call's arguments read as `{ hidden: <placeholder> }`, its result as the placeholder. The answers
 * of earlier turns go without the reasoning their provider replays, each provider's as it signs
 * it. Anything else the model writes, into another tool's arguments or its reply, is public: what
 * it carries of a person's memory there reaches whoever reads the conversation.
 */
export function privateMemoryExtension(
	shared: boolean,
	reader: () => string | undefined,
	draws: MemoryDraws,
): ExtensionFactory {
	return (pi) => {
		pi.on("tool_execution_start", (event) => {
			draws.start(event.toolCallId, event.parentToolCallId);
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
				privateCompaction(
					event.preparation,
					event.branchEntries.flatMap((entry) =>
						entry.type === "message" ? [entry.message] : [],
					),
				);
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
