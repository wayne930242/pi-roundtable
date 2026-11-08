import { type AgentServer, agentRoomKey, type Logger } from "pi-roundtable";
import { HELPERS_ENDED } from "../api-types.ts";
import type { AppSurface } from "./surface.ts";

/** A knight clearing its own temp knights leaves a line in its room, with the undo. */
export function postHelpersEnded(
	agents: Pick<AgentServer, "team" | "directory">,
	surface: Pick<AppSurface, "publish">,
	prefix: string,
	logger: Logger,
): void {
	agents.team.onHelpersEnded((event) => {
		const named = event.names.map((name) => ({
			name,
			displayName: agents.directory.agent(name)?.displayName ?? name,
		}));
		void surface
			.publish({
				room: agentRoomKey(prefix, event.parent),
				kind: "system",
				author: "Notice",
				text: `${HELPERS_ENDED}${JSON.stringify(named)}`,
			})
			.catch((error) =>
				logger.warn({ err: error }, "the temp knights' line was not posted"),
			);
	});
}
