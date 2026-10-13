import { LineError } from "./errors.ts";

/** What a message is, reduced to what a mirror needs. Media bytes are fetched apart, with `LINE.content`. */
export type LineMessageBody =
	| { kind: "text"; text: string }
	| { kind: "image" }
	| { kind: "video"; durationMs?: number }
	| { kind: "audio"; durationMs?: number }
	| { kind: "file"; fileName: string; fileSize?: number }
	| {
			kind: "sticker";
			packageId: string;
			stickerId: string;
			keywords?: string[];
			text?: string;
	  }
	| {
			kind: "location";
			title?: string;
			address?: string;
			latitude: number;
			longitude: number;
	  }
	/** A message type this version does not know; shown as a placeholder rather than dropped. */
	| { kind: "unsupported"; messageType: string };

interface EventBase {
	/** LINE's `webhookEventId`: the same on every redelivery, so a subscriber may use it to deduplicate. */
	eventId: string;
	/** The chat: `line:<group|room|user>:<id>`. */
	sourceKey: string;
	/** LINE's event time, milliseconds since the epoch. */
	timestamp: number;
}

/** A new message. The subscriber mirrors it and answers `{ refs }`, the opaque references to what it made. */
export interface LineMessageEvent extends EventBase {
	type: "message";
	messageId: string;
	/** The sender's user id, when LINE names one. */
	userId?: string;
	body: LineMessageBody;
	/** The message this one quotes, when it quotes one. */
	quotedMessageId?: string;
}

/** The text of a message was edited (groups only; the event with the latest time is the latest state). */
export interface LineEditedEvent extends EventBase {
	type: "edited";
	messageId: string;
	text: string;
	/** What the subscriber answered for the original message, in the order it gave it. */
	refs: readonly string[];
}

/**
 * The sender took a message back. By the time the subscriber hears of it the stored payload is gone
 * and a tombstone stops the message from being mirrored again. `refs` are what it answered for the
 * message, in the order it gave them; empty when nothing was mirrored (yet). Heard more than once
 * when the event is redelivered, so deleting must be idempotent.
 */
export interface LineUnsentEvent extends EventBase {
	type: "unsent";
	messageId: string;
	refs: readonly string[];
}

/**
 * Whether the join notice went out: `"sent"`, `"failed"`, or `"unconfirmed"` when no notice is
 * configured (or it could not be confirmed).
 */
export type JoinNotice = "sent" | "unconfirmed" | "failed";

/** The bot was added to a chat. */
export interface LineJoinedEvent extends EventBase {
	type: "joined";
	notice: JoinNotice;
}

/** The bot was removed from a chat. */
export interface LineLeftEvent extends EventBase {
	type: "left";
}

export interface LineMemberJoinedEvent extends EventBase {
	type: "memberJoined";
	userIds: readonly string[];
}

export interface LineMemberLeftEvent extends EventBase {
	type: "memberLeft";
	userIds: readonly string[];
}

/** How a push the subscriber enqueued ended. Declared now; the outbox that emits it arrives in a later release. */
export interface LineOutboxResultEvent {
	type: "outboxResult";
	sourceKey: string;
	/** The `origin` the subscriber gave when it enqueued, or null. */
	originRef: string | null;
	status: "sent" | "dead" | "refused";
	/** LINE's error code or the package's reason, when the push did not go out. */
	errorCode: string | null;
}

export type LineEvent =
	| LineMessageEvent
	| LineEditedEvent
	| LineUnsentEvent
	| LineJoinedEvent
	| LineLeftEvent
	| LineMemberJoinedEvent
	| LineMemberLeftEvent
	| LineOutboxResultEvent;

/** What a subscriber answers a `message` with. Any other event needs no answer. */
export interface LineMirror {
	/** Opaque references to what the subscriber made for the message (one message may become several posts). */
	refs: readonly string[];
}

/**
 * The one consumer of the package. It is called at least once per event, so it must be idempotent;
 * `signal` aborts when the worker stops or the event is no longer its own. To give up, throw: the
 * event is retried with backoff.
 */
export type LineSubscriber = (
	event: LineEvent,
	signal: AbortSignal,
) => // biome-ignore lint/suspicious/noConfusingVoidType: an async handler that returns nothing is Promise<void>
Promise<LineMirror | undefined | void>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

export const nonEmpty = (value: unknown): string | undefined =>
	typeof value === "string" && value !== "" ? value : undefined;

const num = (value: unknown): number | undefined =>
	typeof value === "number" && Number.isFinite(value) ? value : undefined;

const bad = (what: string): LineError =>
	new LineError("bad_message", `line: the event has no valid ${what}`);

/** The user id inside an event's `source`, when it names one. */
export function senderOf(payload: Record<string, unknown>): string | undefined {
	return isRecord(payload.source) ? nonEmpty(payload.source.userId) : undefined;
}

/** The `message` object of an event. */
export function messageOf(
	payload: Record<string, unknown>,
): Record<string, unknown> {
	if (!isRecord(payload.message)) throw bad("message");
	return payload.message;
}

/** The body of a `message` event's message. Throws `bad_message` when a known type lacks what it needs. */
export function readBody(message: Record<string, unknown>): LineMessageBody {
	const type = nonEmpty(message.type);
	if (!type) throw bad("message type");
	switch (type) {
		case "text": {
			if (typeof message.text !== "string") throw bad("text");
			return { kind: "text", text: message.text };
		}
		case "image":
			return { kind: "image" };
		case "video":
		case "audio": {
			const duration = num(message.duration);
			return duration === undefined
				? { kind: type }
				: { kind: type, durationMs: duration };
		}
		case "file": {
			const fileName = nonEmpty(message.fileName) ?? "file";
			const size = num(message.fileSize);
			return size === undefined
				? { kind: "file", fileName }
				: { kind: "file", fileName, fileSize: size };
		}
		case "sticker": {
			const packageId = nonEmpty(message.packageId);
			const stickerId = nonEmpty(message.stickerId);
			if (!packageId || !stickerId) throw bad("sticker");
			const keywords = Array.isArray(message.keywords)
				? message.keywords.filter((k): k is string => typeof k === "string")
				: undefined;
			const text = nonEmpty(message.text);
			return {
				kind: "sticker",
				packageId,
				stickerId,
				...(keywords && keywords.length > 0 ? { keywords } : {}),
				...(text ? { text } : {}),
			};
		}
		case "location": {
			const latitude = num(message.latitude);
			const longitude = num(message.longitude);
			if (latitude === undefined || longitude === undefined)
				throw bad("location");
			const title = nonEmpty(message.title);
			const address = nonEmpty(message.address);
			return {
				kind: "location",
				latitude,
				longitude,
				...(title ? { title } : {}),
				...(address ? { address } : {}),
			};
		}
		default:
			return { kind: "unsupported", messageType: type.slice(0, 64) };
	}
}

/** The ids of the members a `memberJoined` or `memberLeft` event names. */
export function readMembers(
	payload: Record<string, unknown>,
	field: "joined" | "left",
): string[] {
	const holder = payload[field];
	if (!isRecord(holder) || !Array.isArray(holder.members)) return [];
	return holder.members.flatMap((member) => {
		const id = isRecord(member) ? nonEmpty(member.userId) : undefined;
		return id ? [id] : [];
	});
}
