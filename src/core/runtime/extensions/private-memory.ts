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
 * An earlier answer without its reasoning, or undefined when it gave none: its thinking, encrypted
 * or not, the thought signatures of its tool calls, and those its provider signed its text with,
 * which may carry a person's memory as the turn read it.
 */
function withoutReasoning(message: Assistant): Assistant | undefined {
	const signsReasoning = !MESSAGE_SIGNED.has(message.api);
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
		if (
			part.type === "text" &&
			signsReasoning &&
			part.textSignature !== undefined
		) {
			changed = true;
			const { textSignature: _, ...text } = part;
			return [text];
		}
		return [part];
	});
	return changed ? { ...message, content } : undefined;
}

/**
 * The request's messages as the view allows, or undefined when they need no change. A memory
 * exchange of someone else's reads as a placeholder, the call's arguments as well as its result,
 * so what the model wrote into the call from that memory goes too; in a shared conversation, so
 * does a memory exchange that does not say whose it is, the answers of the turns before the
 * running one read without their reasoning, and the prompt states its history recorded collapse
 * into one leading message of the current prompt, so no earlier turn's memory section remains.
 */
export function memoryProjection(
	messages: Messages,
	view: MemoryView,
): Messages | undefined {
	// The running turn starts at the last message someone wrote; its own reasoning stays its own.
	const running = view.shared
		? messages.findLastIndex((message) => message.role === "user")
		: -1;
	const hidden = hiddenExchanges(messages, view);
	let changed = false;
	const shown = messages.map((message, index) => {
		const projected = projectedMessage(message, hidden, index < running);
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
	return view.shared && MEMORY.has(result.toolName) && !result.isError
		? HIDDEN_UNRECORDED_MEMORY
		: undefined;
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

/** One message as the hidden exchanges allow, or undefined when it needs no change. */
function projectedMessage(
	message: Messages[number],
	hidden: ReadonlyMap<string, string>,
	earlier: boolean,
): Messages[number] | undefined {
	if (message.role === "assistant") {
		const reasoned = earlier ? withoutReasoning(message) : undefined;
		return withHiddenCalls(reasoned ?? message, hidden) ?? reasoned;
	}
	if (message.role !== "toolResult") return undefined;
	const text = hidden.get(message.toolCallId);
	if (text === undefined) return undefined;
	return { ...message, content: [{ type: "text" as const, text }] };
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
	const hidden = hiddenExchanges(messages, { shared: true, reader: undefined });
	return messages.flatMap((message) =>
		message.role === "system"
			? []
			: [projectedMessage(message, hidden, true) ?? message],
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
