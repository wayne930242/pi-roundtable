import { ConfigError } from "../domain/errors.ts";
import type { ChannelKey } from "../sessions.ts";

/** Where the errors go: one agent, or one conversation. */
export type ResolvedOps = { agent: string } | { conversation: ChannelKey };

/** Where the errors go: one of an agent or a conversation; an agent only where the agents live. */
export function opsOf(
	ops: { agent?: string; conversation?: string } | undefined,
	withDiscord: boolean,
): ResolvedOps | undefined {
	if (!ops) return undefined;
	const { agent, conversation } = ops;
	if (agent !== undefined && conversation !== undefined)
		throw new ConfigError(
			"config ops: name an agent or a conversation, not both. Keep the one the reports go to.",
		);
	if (agent !== undefined) {
		if (!withDiscord)
			throw new ConfigError(
				'config ops.agent: the agents live in Discord, which is not configured. Report to a conversation a plugin\'s chat surface serves instead, with ops: { conversation: "<surface>:<id>" }; the web chat takes no error reports.',
			);
		return { agent };
	}
	if (conversation === undefined)
		throw new ConfigError(
			'config ops: name an agent or a conversation, such as ops: { agent: "infra" } or ops: { conversation: "<surface>:<id>" }.',
		);
	if (!/^[^:]+:.+$/.test(conversation))
		throw new ConfigError(
			`config ops.conversation: expected a conversation key <surface>:<id>, got ${JSON.stringify(conversation)}. Write the surface's prefix, a colon, and the conversation's id.`,
		);
	return { conversation: conversation as ChannelKey };
}

/** The error reports' destination that `routing.places.ops` names: a conversation, or an agent's primary place. */
export function opsOfPlace(
	place: ChannelKey | { agent: string } | undefined,
): ResolvedOps | undefined {
	if (place === undefined) return undefined;
	return typeof place === "string" ? { conversation: place } : place;
}
