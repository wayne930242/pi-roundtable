import type { ChannelKey } from "../domain/conversation.ts";
import { AgentError } from "../domain/errors.ts";
import type { AgentDirectory } from "../services.ts";
import type { Agent } from "./agent-store.ts";
import {
	agentRoomKey,
	discordKey,
	keysOf,
	roomSurfaceOf,
} from "./team-keys.ts";

/** What the choice of a message's conversation reads. */
export interface MessageTargetContext {
	store: Pick<AgentDirectory, "agent" | "group">;
	/** The surfaces that host agent rooms. */
	roomSurfaces: readonly string[];
	/** The conversation the target last ran a turn in, if it ran one since the host started. */
	latest: ChannelKey | undefined;
	/** The conversation the sender writes from. */
	from: ChannelKey;
}

/** The word for the web app's conversation, accepted when exactly one surface hosts rooms. */
const WEB = "web";

/**
 * The conversation of `target` that a message is delivered into. With `ask` (a surface name such
 * as "discord", "web", or the surface of a room, or one of the target's conversation keys) that
 * one; otherwise the conversation the target used most recently, and, when it has run none yet,
 * the sender's own surface, so a message between rooms stays among the rooms.
 */
export function messageTarget(
	ctx: MessageTargetContext,
	target: Agent,
	ask: string | undefined,
): ChannelKey {
	const keys = keysOf(ctx.store, target.name, ctx.roomSurfaces);
	const has = keys.length > 0 ? keys.join(", ") : "none";
	if (ask === undefined || ask.trim() === "") {
		if (ctx.latest !== undefined && keys.includes(ctx.latest))
			return ctx.latest;
		const via = roomSurfaceOf(ctx.from);
		if (via === undefined) {
			if (!target.channelId)
				throw new AgentError(`${target.name} has no channel yet.`);
			return discordKey(target.channelId);
		}
		return agentRoomKey(via, target.name);
	}
	const wanted = ask.trim();
	const exact = keys.find((key) => key === wanted);
	if (exact !== undefined) return exact;
	if (wanted === "discord") {
		if (!target.channelId)
			throw new AgentError(
				`${target.name} has no Discord channel; its conversations: ${has}.`,
			);
		return discordKey(target.channelId);
	}
	const surface = ctx.roomSurfaces.includes(wanted)
		? wanted
		: wanted === WEB && ctx.roomSurfaces.length === 1
			? ctx.roomSurfaces[0]
			: undefined;
	if (surface !== undefined) return agentRoomKey(surface, target.name);
	throw new AgentError(
		`${target.name} has no conversation "${wanted}"; its conversations: ${has}. Give "discord", "web" (or the surface's name), or one of those keys.`,
	);
}

/** How a conversation reads to the model that sent a message there: its surface and key. */
export const conversationLabel = (key: ChannelKey): string =>
	`${key.slice(0, key.indexOf(":"))} conversation (${key})`;
