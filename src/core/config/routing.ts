import { ConfigError } from "../domain/errors.ts";
import type { ChannelKey } from "../sessions.ts";
import {
	either,
	type Field,
	list,
	oneOf,
	optional,
	record,
	shape,
	text,
} from "./schema.ts";

/**
 * Where an agent's unprompted work lands: how an event that no person is waiting on picks its
 * conversation. Every key is optional, and a key left out keeps what the host did before `routing`
 * existed. A surface is named by its key prefix, such as `discord` or `app`; `web` stands for the
 * one surface that hosts rooms when exactly one does.
 */
export interface AgentRoutes {
	/**
	 * The agent's primary place, where its unprompted work lands. `"auto"` (default) is its
	 * Discord channel when it has one, else its room on the first surface that hosts rooms; a
	 * surface name picks the agent's place there.
	 */
	primary?: "auto" | (string & {});
	/**
	 * Where a foreign webhook's or integration's post in the agent's place runs its report turn.
	 * `"origin"` (default) is the conversation the post came in; `"primary"` the agent's primary
	 * place; a surface name the agent's place there. The raw post stays where it was posted.
	 */
	integration?: "origin" | "primary" | (string & {});
	/**
	 * The conversation a `message_agent` call reaches when it names none. `"latest"` (default) is
	 * the one the agent last ran a turn in, never carrying a message from a room out to Discord;
	 * `"primary"` the agent's primary place; a surface name the agent's place there.
	 */
	agentMessage?: "latest" | "primary" | (string & {});
	/**
	 * Where an agent's opening task (`agent_create task`) runs. `"origin-surface"` (default) is the
	 * agent's place on the surface the creation came from, else its primary place; `"primary"`
	 * always its primary place.
	 */
	opening?: "origin-surface" | "primary";
	/**
	 * Reserved: surfaces that get a read-only copy of what the agent posts in its primary place.
	 * Not built yet; a non-empty list stops the start.
	 */
	mirror?: string[];
}

/** A named destination of the host: a conversation, or one agent's primary place. */
export type PlaceTarget = `${string}:${string}` | { agent: string };

/** What a surface offers agents; both keys are reserved and only the default is accepted today. */
export interface SurfaceRouting {
	/** `"all"` (default): every agent has a place on the surface. `"none"` is reserved and stops the start. */
	agentPlaces?: "all" | "none";
	/** Reserved: which claim answers the surface's conversations. Not built yet; setting it stops the start. */
	answeredBy?: string;
}

/**
 * The optional `routing` block: one declared table for where events land. Leaving it out keeps
 * every default as it was before the block existed.
 */
export interface RoutingConfig {
	/**
	 * Per-agent rules by agent name; `"*"` is the default of every agent. A name applies to the
	 * agent when it is created later too. A field the agent's entry leaves out falls to `"*"`.
	 */
	agents?: { "*"?: AgentRoutes } & Record<string, AgentRoutes | undefined>;
	/**
	 * Named destinations of the host. `ops` is the process's error reports: a conversation key
	 * `<surface>:<id>`, or `{ agent }` for that agent's primary place.
	 */
	places?: Record<string, PlaceTarget>;
	/** Per-surface settings, by surface name. */
	surfaces?: Record<string, SurfaceRouting>;
}

/** The places the core declares; a name outside this list is a typo until a plugin declares it. */
const DECLARED_PLACES: readonly string[] = ["ops"];

/** The agent-rule keys that name a destination, and the words each accepts besides a surface name. */
export const ROUTE_WORDS = {
	primary: ["auto"],
	integration: ["origin", "primary"],
	agentMessage: ["latest", "primary"],
	opening: ["origin-surface", "primary"],
} as const;

type RouteKey = keyof typeof ROUTE_WORDS;

/** Every word with a meaning of its own; none of them may name a surface. */
const KEYWORDS: readonly string[] = [
	...new Set(Object.values(ROUTE_WORDS).flat()),
];

const AGENT_NAME = /^[a-z0-9-]{1,32}$/;
const CONVERSATION = /^[^:]+:.+$/;

/** A destination of `key`: one of its words, or a surface name; another kind's word is refused. */
function destination(key: RouteKey): Field<string> {
	const words = ROUTE_WORDS[key];
	const describe =
		key === "opening"
			? `one of ${words.join(", ")}`
			: `${words.map((w) => `"${w}"`).join(", ")}, or a surface name`;
	return {
		describe,
		check: (value, path) => {
			const given = text.check(value, path);
			const word = given.trim();
			const own = (words as readonly string[]).includes(word);
			if (!own && (KEYWORDS.includes(word) || key === "opening"))
				throw new ConfigError(
					`config ${path}: ${JSON.stringify(word)} is not a value of ${key}. Use ${describe}.`,
				);
			return word;
		},
	};
}

const agentRoutes = shape({
	primary: optional(destination("primary")),
	integration: optional(destination("integration")),
	agentMessage: optional(destination("agentMessage")),
	opening: optional(destination("opening")),
	mirror: optional(list(text)),
});

const placeTarget: Field<PlaceTarget> = either(
	text as Field<`${string}:${string}`>,
	shape({ agent: text }),
);

const surfaceRouting = shape({
	agentPlaces: optional(oneOf("all" as const, "none" as const)),
	answeredBy: optional(text),
});

/** The `routing` key's shape. */
export const routingShape = optional(
	shape({
		agents: optional(record(agentRoutes)),
		places: optional(record(placeTarget)),
		surfaces: optional(record(surfaceRouting)),
	}),
);

/** The rules of one agent after checking: the reserved keys are gone. */
export interface ResolvedAgentRoutes {
	primary?: string;
	integration?: string;
	agentMessage?: string;
	opening?: "origin-surface" | "primary";
}

/** The checked `routing` block the agent server reads; a host without the key has none. */
export interface ResolvedRouting {
	agents: Readonly<Record<string, ResolvedAgentRoutes>>;
	/** Named destinations: a conversation key, or an agent whose primary place it is. */
	places: Readonly<Record<string, ChannelKey | { agent: string }>>;
}

/** What the rest of the configuration says that the block is checked against. */
export interface RoutingContext {
	/** Whether Discord is configured, so agents have Discord channels. */
	withDiscord: boolean;
	/** Whether the agent server runs: only then do agents and their places exist. */
	agentServer: boolean;
	/** Whether the top-level `ops` is set, which the `ops` place replaces. */
	topLevelOps: boolean;
}

const refuse = (path: string, problem: string, fix: string): ConfigError =>
	new ConfigError(`config ${path}: ${problem}. ${fix}`);

function checkReserved(config: RoutingConfig): void {
	for (const [name, agent] of Object.entries(config.agents ?? {}))
		if ((agent?.mirror?.length ?? 0) > 0)
			throw refuse(
				`routing.agents.${name}.mirror`,
				"mirroring a place is not built yet, so it would do nothing",
				"Remove mirror; the term and the key are reserved until a host needs the copies",
			);
	for (const [surface, rules] of Object.entries(config.surfaces ?? {})) {
		if (rules.agentPlaces === "none")
			throw refuse(
				`routing.surfaces.${surface}.agentPlaces`,
				'"none" is not built yet: Discord makes a channel for every agent, and a surface that hosts rooms hosts one for every agent',
				'Remove agentPlaces or write "all", which is what every surface does',
			);
		if (rules.answeredBy !== undefined)
			throw refuse(
				`routing.surfaces.${surface}.answeredBy`,
				"naming the claim that answers a surface is not built yet; claim priorities decide",
				"Remove answeredBy; give your plugin's claim a priority above the agent server's to answer there",
			);
	}
}

/**
 * Checks the block against the rest of the configuration, naming the key and the fix. Surfaces
 * are checked again once the plugins have registered theirs, when the agent server links.
 */
export function routingOf(
	config: RoutingConfig | undefined,
	context: RoutingContext,
): ResolvedRouting | undefined {
	if (!config) return undefined;
	const agents = config.agents ?? {};
	const places = config.places ?? {};
	const surfaces = config.surfaces ?? {};
	checkReserved(config);
	for (const name of Object.keys(agents))
		if (name !== "*" && !AGENT_NAME.test(name))
			throw refuse(
				`routing.agents.${name}`,
				'not an agent name: lowercase letters, digits and dashes, 1 to 32, or "*" for every agent',
				"Rename the key to the agent's name",
			);
	for (const name of Object.keys(places))
		if (!DECLARED_PLACES.includes(name))
			throw refuse(
				`routing.places.${name}`,
				`no place is called ${JSON.stringify(name)}`,
				`The places are ${DECLARED_PLACES.join(", ")}`,
			);
	for (const [name, target] of Object.entries(places))
		if (typeof target === "string" && !CONVERSATION.test(target))
			throw refuse(
				`routing.places.${name}`,
				`expected a conversation key <surface>:<id> or { agent }, got ${JSON.stringify(target)}`,
				"Write the surface's prefix, a colon, and the conversation's id, or name an agent",
			);
	if (places.ops !== undefined && context.topLevelOps)
		throw refuse(
			"routing.places.ops",
			"the top-level ops is set as well, and both say where the error reports go",
			"Keep one: move ops into routing.places.ops and remove the top-level ops",
		);
	const needsAgents =
		Object.keys(agents).length > 0 ||
		Object.keys(surfaces).length > 0 ||
		(typeof places.ops === "object" && places.ops !== undefined);
	if (needsAgents && !context.agentServer)
		throw refuse(
			"routing",
			"agents, per-surface settings and an agent place need the agent server, and this host runs none (agentServer is false, or there is neither discord nor agents)",
			"Remove those keys from routing, or remove agentServer: false and configure discord or agents",
		);
	if (!context.withDiscord) {
		const named = Object.entries(agents).flatMap(([name, rules]) =>
			(["primary", "integration", "agentMessage"] as const)
				.filter((key) => rules?.[key] === "discord")
				.map((key) => `routing.agents.${name}.${key}`),
		);
		if (named[0] || surfaces.discord)
			throw refuse(
				named[0] ?? "routing.surfaces.discord",
				"names the discord surface, and Discord is not configured",
				"Name a surface that hosts rooms instead, or configure discord",
			);
	}
	return {
		agents: Object.fromEntries(
			Object.entries(agents).flatMap(([name, rules]) =>
				rules === undefined
					? []
					: [
							[
								name,
								{
									...(rules.primary ? { primary: rules.primary } : {}),
									...(rules.integration
										? { integration: rules.integration }
										: {}),
									...(rules.agentMessage
										? { agentMessage: rules.agentMessage }
										: {}),
									...(rules.opening ? { opening: rules.opening } : {}),
								},
							],
						],
			),
		),
		places: Object.fromEntries(
			Object.entries(places).map(([name, target]) => [
				name,
				typeof target === "string" ? (target as ChannelKey) : target,
			]),
		),
	};
}
