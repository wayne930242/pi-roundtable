/** An assistant message of a Pi session, as far as its final answer needs it. */
export interface AssistantLike {
	role: "assistant";
	content: unknown;
	stopReason?: string;
	errorMessage?: string;
}

/** The text parts of a message's content, joined by newlines. */
export function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(part): part is { type: "text"; text: string } =>
				part?.type === "text" && typeof part.text === "string",
		)
		.map((part) => part.text)
		.join("\n");
}

/**
 * A run's last assistant message, or why there is no usable one: none at all, a failed run, or
 * an aborted one. `aborted` names an abort that carries no error message of its own.
 */
export function lastAssistant<M extends { role: string }>(
	messages: readonly M[],
	aborted?: string,
): { ok: true; message: M & AssistantLike } | { ok: false; error: string } {
	const last = messages.findLast(
		(message): message is M & AssistantLike => message.role === "assistant",
	);
	if (!last)
		return { ok: false, error: "the run produced no assistant message" };
	if (
		last.errorMessage ||
		last.stopReason === "error" ||
		last.stopReason === "aborted"
	) {
		return {
			ok: false,
			error:
				last.errorMessage ??
				(last.stopReason === "aborted" && aborted
					? aborted
					: `the run stopped with ${last.stopReason}`),
		};
	}
	return { ok: true, message: last };
}
