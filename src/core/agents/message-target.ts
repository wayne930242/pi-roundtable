import type { ChannelKey } from "../domain/conversation.ts";
import { AgentError } from "../domain/errors.ts";
import type { AgentDirectory } from "../plugin-api/services.ts";
import type { Agent } from "./agent-store.ts";
import { Routes } from "./routes.ts";
import type { TeamPlaces } from "./team-places.ts";

/** What the choice of a message's conversation reads. */
export interface MessageTargetContext {
	store: Pick<AgentDirectory, "agent" | "group">;
	/** Where the agents are: their places on the surfaces that hold them. */
	places: Pick<
		TeamPlaces,
		"keysOf" | "placeOn" | "rooms" | "surfaces" | "roomSurfaceOf"
	>;
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
	const keys = ctx.places.keysOf(target.name);
	const has = keys.length > 0 ? keys.join(", ") : "none";
	const routes =
		ctx.routes ??
		new Routes({
			store: ctx.store,
			places: ctx.places,
			latest: () => ctx.latest,
		});
	if (ask === undefined || ask.trim() === "")
		return routes.of(target.name, "agentMessage", ctx.from);
	const wanted = ask.trim();
	const exact = keys.find((key) => key === wanted);
	if (exact !== undefined) return exact;
	const rooms = ctx.places.rooms();
	// A surface whose places are stored: the agent has one there or none.
	if (
		wanted === "discord" ||
		(!rooms.includes(wanted) && ctx.places.surfaces().includes(wanted))
	) {
		const place = routes.placeOn(target.name, wanted);
		if (!place)
			throw new AgentError(
				`${target.name} has no ${wanted === "discord" ? "Discord channel" : `place on ${wanted}`}; its conversations: ${has}.`,
			);
		return place;
	}
	const surface = rooms.includes(wanted)
		? wanted
		: wanted === WEB && rooms.length === 1
			? rooms[0]
			: undefined;
	const room =
		surface === undefined
			? undefined
			: ctx.places.placeOn(target.name, surface);
	if (room !== undefined) return room;
	throw new AgentError(
		`${target.name} has no conversation "${wanted}"; its conversations: ${has}. Give "discord", "web" (or the surface's name), or one of those keys.`,
	);
}

/** How a conversation reads to the model that sent a message there: its surface and key. */
export const conversationLabel = (key: ChannelKey): string =>
	`${key.slice(0, key.indexOf(":"))} conversation (${key})`;
