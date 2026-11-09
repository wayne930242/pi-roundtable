import type { AgentTurnScope } from "../domain/ports.ts";
import { SYSTEM_PRINCIPAL } from "../identity/principal-store.ts";
import type { Speaker } from "../identity/speakers.ts";
import type { ModeOrigins } from "../modes/mode-inheritance.ts";
import type { AgentDirectory } from "../plugin-api/services.ts";
import { isHelper } from "./agent-rules.ts";
import type { Agent } from "./agent-store.ts";
import type { TeamContext } from "./team-options.ts";
import type { TeamPlaces } from "./team-places.ts";

/**
 * Makes the temp knight's conversations follow the modes of the conversation that asked for it,
 * live, so turning yolo or long-running on or off there applies to it at once. This adds no
 * permission: an owner turns the modes on there. Only a turn of an owner can carry them over, as
 * for any change of modes; any other turn's temp knight starts with its own, both off, whatever
 * an earlier agent of the same name followed.
 */
export async function followOrigin(
	ctx: TeamContext,
	caller: AgentTurnScope,
	speaker: Speaker,
	helper: Agent,
): Promise<void> {
	const { places } = ctx.options;
	const modes = ctx.options.modes?.();
	if (!modes) return;
	const keys = places.keysOf(helper.name);
	if (speaker.tier !== "owner" || speaker.principalId === SYSTEM_PRINCIPAL) {
		for (const key of keys) await modes.forget(key);
		return;
	}
	await modes.follow(keys, ctx.turns.turnChannel(caller), speaker);
}

/**
 * What the agent server says of a conversation that follows another's modes: it still does while
 * it is a temp knight's conversation made from that origin, named after the temp knight's parent;
 * the origin is gone once the agent or group whose conversation it is (else the parent) is
 * archived or deleted.
 */
export function modeOrigins(
	store: Pick<AgentDirectory, "agent">,
	places: Pick<TeamPlaces, "agentOf" | "groupOf">,
): ModeOrigins {
	return {
		originOf: (channel, origin) => {
			const helper = places.agentOf(channel);
			if (!helper || !isHelper(helper) || helper.origin !== origin)
				return undefined;
			const parent = store.agent(helper.parent as string);
			const owner = places.agentOf(origin) ?? places.groupOf(origin) ?? parent;
			return {
				name: parent?.displayName ?? (helper.parent as string),
				alive: owner?.status === "active",
			};
		},
	};
}
