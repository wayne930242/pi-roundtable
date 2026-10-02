import type { TurnResult } from "../domain/conversation.ts";
import { AgentRunError } from "../domain/errors.ts";
import { hasReplyFiles } from "../reply-files.ts";
import { lastAssistant, textOf } from "../shared/session-messages.ts";

interface MessagePart {
	type?: unknown;
	text?: unknown;
	thinking?: unknown;
	redacted?: unknown;
}

type Message = { role: string };
type Assistant = Message & {
	role: "assistant";
	content: unknown;
	stopReason?: string;
};

const isAssistant = (message: Message): message is Assistant =>
	message.role === "assistant";

/** The session's last answer, which tells the judge what a short follow-up continues. */
export function lastReply(messages: readonly Message[]): string | undefined {
	const last = messages.findLast(isAssistant);
	return last ? textOf(last.content).trim() || undefined : undefined;
}

/** The visible thinking of the messages a turn added, in order. */
export function thinkingOf(messages: readonly Message[]): string {
	return messages
		.filter(isAssistant)
		.flatMap((message) =>
			Array.isArray(message.content)
				? (message.content as (MessagePart | undefined)[])
				: [],
		)
		.flatMap((part) =>
			part?.type === "thinking" &&
			typeof part.thinking === "string" &&
			part.redacted !== true
				? [part.thinking.trim()]
				: [],
		)
		.filter(Boolean)
		.join("\n\n");
}

/**
 * A finished turn's result from the messages it added. A steered run may have answered before
 * the steer arrived, so every final answer of it is kept.
 */
export function turnAnswer(
	messages: readonly Message[],
	steered: boolean,
): TurnResult {
	const last = lastAssistant(messages);
	if (!last.ok) return { ok: false, error: new AgentRunError(last.error) };
	const text = (
		steered
			? messages
					.flatMap((message) =>
						isAssistant(message) && message.stopReason === "stop"
							? [textOf(message.content).trim()]
							: [],
					)
					.filter(Boolean)
					.join("\n\n")
			: textOf(last.message.content)
	).trim();
	if (!text && !hasReplyFiles())
		return {
			ok: false,
			error: new AgentRunError("the final assistant message has no text"),
		};
	const thinking = thinkingOf(messages);
	return { ok: true, text, ...(thinking ? { thinking } : {}) };
}
