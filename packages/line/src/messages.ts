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
 * Whether the join notice went out: `"sent"` (LINE took the Reply), `"failed"` (the Reply was
 * refused, the token had lapsed or the notice's text is not the one its digest names; nothing else
 * was sent in its place), or `"unconfirmed"` when no notice is configured, or the first try was cut
 * short and nobody knows whether LINE got it.
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

/**
 * How a push ended, told once per `origin` the push carries (or once with `originRef: null` when it
 * carries none). At least once: a subscriber that fails is told again later, so it must be idempotent.
 * It has no event id or time; the push is not a webhook event.
 */
export interface LineOutboxResultEvent {
	type: "outboxResult";
	sourceKey: string;
	/** The `origin` the subscriber gave when it enqueued, or null. */
	originRef: string | null;
	/**
	 * `sent` (accepted, or already accepted under the same retry key), `dead` (LINE refused it, or it
	 * kept failing, or its retry key lapsed), or `refused` (the quota gate would have been exceeded; nothing was sent).
	 */
	status: "sent" | "dead" | "refused";
	/**
	 * Why the push did not go out: LINE's refusal as a code (`http_400`, `sender_name_refused`,
	 * `sender_icon_refused`, ...) or the package's reason (`quota_exhausted`, `retry_key_expired`,
	 * `source_not_allowed`); null when it was sent.
	 */
	errorCode: string | null;
	/**
	 * How many tries the push took, the one that ended it included: 1 for a push LINE refused at once,
	 * 2 after a `5xx` and then a refusal. A try counts once its request has been made to LINE, also
	 * when a stop cut it short, and once the worker took the push up only to end it without a request
	 * (`refused`, `source_not_allowed`); a stop before the request does not count.
	 */
	attempts: number;
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
 * What a subscriber can do while it handles a `message`. For any other event `keep` rejects with
 * `keep_unavailable`.
 */
export interface LineContext {
	/**
	 * Keeps the reference of a post the subscriber has just made, at once: stored under the same
	 * per-message lock and tombstone check as the references it answers at the end, so the post can
	 * still be taken back if the handler fails later (the references stay stored for the retry and for
	 * an `unsent`). Calling it again for a kept reference changes nothing. Resolves `{ unsent: true }`
	 * when the sender had already taken the message back: the reference has then been handed to the
	 * subscriber as `unsent` already, and the subscriber should stop mirroring.
	 */
	keep(ref: string): Promise<{ unsent: boolean }>;
}

/**
 * The one consumer of the package. It is called at least once per event, so it must be idempotent;
 * `signal` aborts when the worker stops or the event is no longer its own. To give up, throw: the
 * event is retried with backoff (a returned value is never read as a retry request, and a `message`
 * answer that is not `{ refs }` fails with `bad_refs`).
 *
 * A `message` may become several posts. Call `context.keep(ref)` as each post lands: the references
 * of posts made before a later one fails are then still known to the retry and to an `unsent`, so
 * none is left behind. Refs returned at the end merge with the kept ones. Only a crash between a post
 * and its `keep` can leave a post the package does not know of.
 */
export type LineSubscriber = (
	event: LineEvent,
	signal: AbortSignal,
	context: LineContext,
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
