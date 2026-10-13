import type { InboundMessage } from "pi-roundtable";
import { parseSourceKey } from "./events.ts";
import type { LineMessageEvent } from "./messages.ts";

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The text of a LINE message with the bot's own mentions cut out, and whether it had any. LINE
 * names each mention by position and length in the text.
 */
export function stripSelfMentions(
	text: string,
	message: Record<string, unknown>,
): { text: string; mentionsBot: boolean } {
	const mentionees = isRecord(message.mention)
		? message.mention.mentionees
		: [];
	const spans = (Array.isArray(mentionees) ? mentionees : [])
		.filter(
			(m): m is Record<string, unknown> => isRecord(m) && m.isSelf === true,
		)
		.map((m) => ({ start: Number(m.index), length: Number(m.length) }))
		.filter(
			(s) =>
				Number.isInteger(s.start) &&
				Number.isInteger(s.length) &&
				s.start >= 0 &&
				s.length > 0 &&
				s.start + s.length <= text.length,
		)
		.sort((a, b) => b.start - a.start);
	let stripped = text;
	for (const span of spans)
		stripped =
			stripped.slice(0, span.start) + stripped.slice(span.start + span.length);
	return { text: stripped.trim(), mentionsBot: spans.length > 0 };
}

/**
 * A text message of an allowed chat as the host's router takes it, or undefined when it is not one
 * the router can serve: not text, or from a sender LINE did not name, who cannot be resolved to a
 * person.
 */
export function inboundOf(
	event: LineMessageEvent,
	message: Record<string, unknown>,
): InboundMessage | undefined {
	if (event.body.kind !== "text" || !event.userId) return undefined;
	const source = parseSourceKey(event.sourceKey);
	if (!source) return undefined;
	const { text, mentionsBot } = stripSelfMentions(event.body.text, message);
	return {
		channel: `line:${source.kind}:${source.id}`,
		messageId: event.messageId,
		actor: {
			provider: "line",
			subject: event.userId,
			name: event.userId,
			surface: "line",
		},
		authorId: event.userId,
		authorName: event.userId,
		authorIsBot: false,
		isDirect: source.kind === "user",
		mentionsBot,
		repliesToBot: false,
		text,
		attachments: [],
	};
}
