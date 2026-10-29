import type { CharacterSpec } from "../../characters/index.ts";
import type { Logger } from "../log.ts";
import type { Agent } from "./agent-store.ts";

/** What the refresh needs of the team: the agents, a render, and a way to set the picture. */
export interface AvatarRefreshDeps {
	agents(): readonly Agent[];
	/** Renders a look to its picture and returns the content hash; the same look gives the same hash. */
	render(character: CharacterSpec): Promise<string>;
	/** The agent as the store holds it now. */
	agent(name: string): Agent | undefined;
	setAvatar(name: string, avatarHash: string): Promise<unknown>;
	logger: Logger;
}

export interface AvatarRefreshResult {
	rendered: number;
	unchanged: number;
	failed: number;
}

const lookOf = (agent: Agent | undefined) => JSON.stringify(agent?.character);

/**
 * Renders every active agent that has a character again and sets the picture when its hash
 * differs from the stored one, so a restart with nothing changed writes nothing. One agent's
 * failure is counted and does not stop the others. An agent whose look changed while it rendered
 * keeps the newer picture. Logs one summary line.
 */
export async function refreshAvatars(
	deps: AvatarRefreshDeps,
): Promise<AvatarRefreshResult> {
	const { agents, render, agent: current, setAvatar, logger } = deps;
	const result: AvatarRefreshResult = { rendered: 0, unchanged: 0, failed: 0 };
	const reasons: string[] = [];
	for (const agent of agents()) {
		if (agent.status !== "active" || !agent.character) continue;
		try {
			const avatarHash = await render(agent.character);
			const latest = current(agent.name);
			if (
				avatarHash === latest?.avatarHash ||
				latest?.status !== "active" ||
				lookOf(latest) !== lookOf(agent)
			) {
				result.unchanged++;
				continue;
			}
			await setAvatar(agent.name, avatarHash);
			result.rendered++;
		} catch (error) {
			result.failed++;
			reasons.push(
				`${agent.name}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	const summary = { ...result, ...(reasons.length > 0 ? { reasons } : {}) };
	if (result.failed > 0)
		logger.warn(
			summary,
			`avatars refreshed: re-rendered ${result.rendered}, unchanged ${result.unchanged}, failed ${result.failed}`,
		);
	else
		logger.info(
			summary,
			`avatars refreshed: re-rendered ${result.rendered}, unchanged ${result.unchanged}, failed 0`,
		);
	return result;
}
