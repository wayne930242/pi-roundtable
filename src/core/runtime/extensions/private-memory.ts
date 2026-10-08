import { getCurrentSystemMessage } from "@earendil-works/pi-ai";
import type {
	ContextWithSystemEvent,
	ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { MEMORY_TOOLS } from "../../modules/memory/owner-memory.ts";

type Messages = ContextWithSystemEvent["messages"];

/** What the model reads in place of a result that holds someone else's memory. */
export const HIDDEN_MEMORY = "(another person's private memory, hidden)";
/** What it reads in place of a memory result recorded before results said whose they were. */
export const HIDDEN_UNRECORDED_MEMORY =
	"(a private memory result that does not say whose it is, hidden)";

const MEMORY = new Set<string>(MEMORY_TOOLS);

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

/**
 * The request's messages as the view allows, or undefined when they need no change. A tool result
 * holding someone else's memory reads as a placeholder; in a shared conversation, so does a memory
 * result that does not say whose it is, and the prompt states its history recorded collapse into
 * one leading message of the current prompt, so no earlier turn's memory section remains.
 */
export function memoryProjection(
	messages: Messages,
	view: MemoryView,
): Messages | undefined {
	let changed = false;
	const shown = messages.map((message) => {
		if (message.role !== "toolResult") return message;
		const whose = privateTo(message.details);
		const hidden =
			whose !== undefined
				? whose !== view.reader && HIDDEN_MEMORY
				: view.shared &&
					MEMORY.has(message.toolName) &&
					!message.isError &&
					HIDDEN_UNRECORDED_MEMORY;
		if (!hidden) return message;
		changed = true;
		return { ...message, content: [{ type: "text" as const, text: hidden }] };
	});
	const prompts = shown.filter((message) => message.role === "system").length;
	if (!view.shared || prompts <= 1) return changed ? shown : undefined;
	const head = getCurrentSystemMessage(shown);
	if (!head) return changed ? shown : undefined;
	return [head, ...shown.filter((message) => message.role !== "system")];
}

/**
 * Projects each model request of a session so it carries no one's memory but the running turn's
 * reader's: a person's memory is theirs per request, never the history's to share.
 */
export function privateMemoryExtension(
	shared: boolean,
	reader: () => string | undefined,
): ExtensionFactory {
	return (pi) => {
		pi.on("context_with_system", (event) => {
			const messages = memoryProjection(event.messages, {
				shared,
				reader: reader(),
			});
			return messages ? { messages } : undefined;
		});
	};
}
