import type { ChannelKey } from "../domain/conversation.ts";
import { AgentError } from "../domain/errors.ts";
import type { AgentDirectory } from "../services.ts";
import type { Agent } from "./agent-store.ts";
import { Routes } from "./routes.ts";
import { agentRoomKey, keysOf } from "./team-keys.ts";

/** What the choice of a message's conversation reads. */
export interface MessageTargetContext {
	store: Pick<AgentDirectory, "agent" | "group">;
	/** The surfaces that host agent rooms. */
	roomSurfaces: readonly string[];
	/**
	 * The conversation the target last ran a turn in, if it ran one since the host started; read
	 * only under the `"latest"` routing rule, and only on the sender's surface.
	 */
	latest: ChannelKey | undefined;
	/** The conversation the sender writes from: the origin whose surface the message stays on. */
	from: ChannelKey;
	/** The host's routing table; without it the defaults every host had before `routing`. */
	routes?: Pick<Routes, "of" | "placeOn">;
}

/** The word for the web app's conversation, accepted when exactly one surface hosts rooms. */
const WEB = "web";

/**
 * The conversation of `target` that a message is delivered into. With `ask` (a surface name such
 * as "discord", "web", or the surface of a room, or one of the target's conversation keys) that
 * one; otherwise the conversation the routing table picks (`Routes.of`): by default the target's
 * place on the sender's own surface, so a message never crosses surfaces unless named.
 */
export function messageTarget(
	ctx: MessageTargetContext,
	target: Agent,
	ask: string | undefined,
): ChannelKey {
	const keys = keysOf(ctx.store, target.name, ctx.roomSurfaces);
	const has = keys.length > 0 ? keys.join(", ") : "none";
	const routes =
		ctx.routes ??
		new Routes({
			store: ctx.store,
			roomSurfaces: () => ctx.roomSurfaces,
			latest: () => ctx.latest,
		});
	if (ask === undefined || ask.trim() === "")
		return routes.of(target.name, "agentMessage", ctx.from);
	const wanted = ask.trim();
	const exact = keys.find((key) => key === wanted);
	if (exact !== undefined) return exact;
	if (wanted === "discord") {
		const place = routes.placeOn(target.name, "discord");
		if (!place)
			throw new AgentError(
				`${target.name} has no Discord channel; its conversations: ${has}.`,
			);
		return place;
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
