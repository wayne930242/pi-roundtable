import type { TranscriptEntry, TurnResult } from "../domain/conversation.ts";
import { AgentRunError } from "../domain/errors.ts";
import { hasReplyFiles } from "../reply-files.ts";
import { lastAssistant, textOf } from "../shared/session-messages.ts";
import { TRANSCRIPT_ENTRY_CHARS } from "./runtime-types.ts";

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

/** The answer to a turn sent without a speaker: refused, never run as the owner's by default. */
export function unspokenTurn(): TurnResult {
	return {
		ok: false,
		error: new AgentRunError(
			"a turn needs a speaker: pass TurnRequest.speaker, the person the turn is for; for a turn started on someone's behalf, get theirs from IDENTITY.speakerFor",
		),
	};
}

/** The last `limit` user and assistant messages as transcript entries, each cut to its first characters. */
export function transcriptOf(
	messages: readonly (Message & { content?: unknown })[],
	limit: number,
): TranscriptEntry[] {
	const entries: TranscriptEntry[] = [];
	for (const message of messages) {
		if (message.role !== "user" && message.role !== "assistant") continue;
		const text = textOf(message.content).trim();
		if (text)
			entries.push({
				role: message.role,
				text: text.slice(0, TRANSCRIPT_ENTRY_CHARS),
			});
	}
	return entries.slice(-limit);
}

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
