import { LineError } from "./errors.ts";

export type SourceKind = "group" | "room" | "user";

const ID = /^[A-Za-z0-9_-]{1,64}$/;

/** `line:<group|room|user>:<id>`, the channel key's tail every other part of the package names a chat by. */
export function sourceKeyOf(kind: SourceKind, id: string): string {
	return `line:${kind}:${id}`;
}

/** The kind and id inside a source key, or undefined when the text is not one. */
export function parseSourceKey(
	key: string,
): { kind: SourceKind; id: string } | undefined {
	const match = /^line:(group|room|user):([A-Za-z0-9_-]{1,64})$/.exec(key);
	return match
		? { kind: match[1] as SourceKind, id: match[2] as string }
		: undefined;
}

/** One webhook event, reduced to what the inbox keeps in columns; the event itself is `raw`. */
export interface ParsedEvent {
	/** LINE's `webhookEventId`, or a digest of the event when it has none. */
	id: string;
	type: string;
	timestamp: number;
	/** Null when the event names no chat the package knows. */
	sourceKey: string | null;
	messageId: string | null;
	/** False for events of a bot in standby mode, which are never mirrored. */
	active: boolean;
	raw: Record<string, unknown>;
}

export interface ParsedWebhook {
	destination: string | null;
	events: ParsedEvent[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown): string | null =>
	typeof value === "string" && value !== "" ? value : null;

/** The key of the chat an event's `source` names. */
function sourceOf(source: unknown): string | null {
	if (!isRecord(source)) return null;
	for (const [kind, field] of [
		["group", "groupId"],
		["room", "roomId"],
		["user", "userId"],
	] as const) {
		if (source.type !== kind) continue;
		const id = text(source[field]);
		return id && ID.test(id) ? sourceKeyOf(kind, id) : null;
	}
	return null;
}

async function digest(value: string): Promise<string> {
	const bytes = new TextEncoder().encode(value);
	const hash = await crypto.subtle.digest("SHA-256", bytes);
	return Buffer.from(hash).toString("hex");
}

/**
 * Reads a webhook body. Throws `LineError("bad_webhook")` when it is not JSON or has no `events`
 * array; an event of an unexpected shape is kept (as an event with no chat) rather than refused,
 * so one odd event never costs the others of its request.
 */
export async function parseWebhook(body: Uint8Array): Promise<ParsedWebhook> {
	let value: unknown;
	try {
		value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
	} catch {
		throw new LineError("bad_webhook", "line: the webhook body is not JSON");
	}
	if (!isRecord(value) || !Array.isArray(value.events))
		throw new LineError(
			"bad_webhook",
			"line: the webhook body has no events array",
		);
	const events: ParsedEvent[] = [];
	for (const raw of value.events) {
		if (!isRecord(raw)) continue;
		const message = isRecord(raw.message) ? raw.message : undefined;
		const unsend = isRecord(raw.unsend) ? raw.unsend : undefined;
		const timestamp = Number(raw.timestamp);
		events.push({
			id:
				text(raw.webhookEventId) ??
				`derived:${await digest(JSON.stringify(raw))}`,
			type: text(raw.type) ?? "unknown",
			timestamp: Number.isSafeInteger(timestamp) ? timestamp : 0,
			sourceKey: sourceOf(raw.source),
			messageId: text(message?.id) ?? text(unsend?.messageId),
			active: raw.mode === undefined || raw.mode === "active",
			raw,
		});
	}
	return { destination: text(value.destination), events };
}
