import type { CharacterSpec } from "../../characters/index.ts";
import type { Logger } from "../log.ts";
import type { Agent } from "./agent-store.ts";

/** What the refresh needs of the team: the agents, a render, and a way to set the picture. */
export interface AvatarRefreshDeps {
	agents(): readonly Agent[];
	/** Renders a look to its picture and returns the content hash; the same look gives the same hash. */
	render(character: CharacterSpec): Promise<string>;
	/**
	 * Sets the picture only while the agent is active and still wears `character`; false when it
	 * does not, which leaves the newer look's picture alone.
	 */
	setAvatar(
		name: string,
		character: CharacterSpec,
		avatarHash: string,
	): Promise<boolean>;
	/** Set when the team stops: no further render, write or log happens. */
	signal?: AbortSignal;
	logger: Logger;
}

export interface AvatarRefreshResult {
	rendered: number;
	unchanged: number;
	/** Archived, or given another look, while it rendered. */
	skipped: number;
	failed: number;
}

/**
 * Renders every active agent that has a character again and sets the picture when its hash
 * differs from the stored one, so a restart with nothing changed writes nothing. One agent's
 * failure is counted and does not stop the others. An agent archived or given another look while
 * it rendered is skipped, so the newer picture stays. Stops at once when the signal aborts, with
 * no further write or log. Logs one summary line.
 */
export async function refreshAvatars(
	deps: AvatarRefreshDeps,
): Promise<AvatarRefreshResult> {
	const { agents, render, setAvatar, signal, logger } = deps;
	const result: AvatarRefreshResult = {
		rendered: 0,
		unchanged: 0,
		skipped: 0,
		failed: 0,
	};
	const reasons: string[] = [];
	for (const agent of agents()) {
		if (signal?.aborted) return result;
		if (agent.status !== "active" || !agent.character) continue;
		try {
			const avatarHash = await render(agent.character);
			if (signal?.aborted) return result;
			if (avatarHash === agent.avatarHash) {
				result.unchanged++;
				continue;
			}
			if (await setAvatar(agent.name, agent.character, avatarHash))
				result.rendered++;
			else result.skipped++;
		} catch (error) {
			if (signal?.aborted) return result;
			result.failed++;
			reasons.push(
				`${agent.name}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	if (signal?.aborted) return result;
	const summary = { ...result, ...(reasons.length > 0 ? { reasons } : {}) };
	const line = `avatars refreshed: re-rendered ${result.rendered}, unchanged ${result.unchanged}, skipped ${result.skipped}, failed ${result.failed}`;
	if (result.failed > 0) logger.warn(summary, line);
	else logger.info(summary, line);
	return result;
}
