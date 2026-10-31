import type { ChannelKey } from "../sessions.ts";
import type { ConversationMode } from "./conversation-modes.ts";

/**
 * What the agent server says of a conversation that follows another's modes, given to
 * `ConversationModes.trackOrigins`.
 */
export interface ModeOrigins {
	/**
	 * Whether `channel` still follows `origin`, as a temp knight's conversation follows the one it
	 * was made from, and the origin's name to show: undefined when it no longer does (its agent is
	 * gone, or the name is another agent's now), so its own modes count again; `alive: false` when
	 * the origin conversation is gone, so both modes read off.
	 */
	originOf(
		channel: ChannelKey,
		origin: ChannelKey,
	): { name: string; alive: boolean } | undefined;
}

/** A conversation's stored modes, and the conversation it follows when it follows one. */
export interface StoredMode {
	own: ConversationMode;
	follows?: ChannelKey;
}

const OFF: ConversationMode = Object.freeze({
	yolo: false,
	longRunning: false,
});

/**
 * A conversation's modes as they apply now: its own, or, for one that follows another, the
 * origin's own modes with `inheritedFrom`, both off when the origin is gone. One level only: an
 * origin's modes are its own, whatever it follows. Without `origins` an origin counts as alive.
 */
export function resolveMode(
	channel: ChannelKey,
	stored: (channel: ChannelKey) => StoredMode | undefined,
	origins: ModeOrigins | undefined,
): ConversationMode {
	const mine = stored(channel);
	if (!mine) return OFF;
	const follows = mine.follows;
	if (follows === undefined) return mine.own;
	const origin = origins
		? origins.originOf(channel, follows)
		: { name: undefined, alive: true };
	if (!origin) return mine.own;
	const from = origin.alive ? (stored(follows)?.own ?? OFF) : OFF;
	return Object.freeze({
		yolo: from.yolo,
		longRunning: from.longRunning,
		...(from.changedBy === undefined ? {} : { changedBy: from.changedBy }),
		...(from.changedAt === undefined ? {} : { changedAt: from.changedAt }),
		inheritedFrom: {
			channel: follows,
			...(origin.name === undefined ? {} : { name: origin.name }),
			...(origin.alive ? {} : { gone: true as const }),
		},
	});
}

/** The conversations that follow `origin` now, from every stored one. */
export function followersOf(
	origin: ChannelKey,
	all: Iterable<[ChannelKey, StoredMode]>,
	origins: ModeOrigins | undefined,
): ChannelKey[] {
	const found: ChannelKey[] = [];
	for (const [channel, mode] of all)
		if (
			mode.follows === origin &&
			(!origins || origins.originOf(channel, origin) !== undefined)
		)
			found.push(channel);
	return found;
}
