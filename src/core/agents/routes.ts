import type {
	ResolvedAgentRoutes,
	ResolvedRouting,
} from "../config/routing.ts";
import { ROUTE_WORDS } from "../config/routing.ts";
import { parseChannelKey } from "../contract/surface.ts";
import type { ChannelKey } from "../domain/conversation.ts";
import { AgentError, ConfigError } from "../domain/errors.ts";
import type { AgentDirectory } from "../services.ts";
import {
	agentRoomKey,
	discordKey,
	keysOf,
	roomSurfaceOf,
} from "./team-keys.ts";

/**
 * The routing table: where an agent's work lands when no person is waiting on it. An agent's
 * *place* on a surface is its Discord channel or its room there; its *primary place* is where
 * unprompted work lands. Work a person started, or that waits on a person, is never routed.
 * Read it as `AGENTS.routes`.
 */
export interface RoutingTable {
	/**
	 * The agent's primary place: the surface its rules name; with `"auto"` (the default) its Discord
	 * channel when it has one, else its room on the first surface that hosts rooms. Undefined for
	 * an unknown agent.
	 */
	primary(agent: string): ChannelKey | undefined;
	/** The agent's place on a surface (`"web"` for the one surface that hosts rooms); undefined when it has none there. */
	placeOn(agent: string, surface: string): ChannelKey | undefined;
	/**
	 * The conversation an event of `kind` for the agent lands in; `origin` is where it came in
	 * (a webhook post's conversation, the sender's turn channel, the conversation that asked for
	 * the agent). An `integration` event is never dropped: a vanished destination sends it to its
	 * origin. An `agentMessage` throws AgentError when the agent has no place; an `opening` task
	 * has none when the agent has no place at all.
	 */
	of(agent: string, kind: "integration", origin: ChannelKey): ChannelKey;
	of(agent: string, kind: "agentMessage", origin: ChannelKey): ChannelKey;
	of(
		agent: string,
		kind: RouteKind,
		origin?: ChannelKey,
	): ChannelKey | undefined;
	/** A named destination of the host, such as `ops`; undefined when none is set or its agent is not active. */
	place(name: string): ChannelKey | undefined;
}

/** What starts agent work with no person waiting on the answer, and so may be routed. */
export type RouteKind = "integration" | "agentMessage" | "opening";

/** The word for the web app's surface, taken for it when exactly one surface hosts rooms. */
const WEB = "web";

/** What the table writes to: a warning with its fields. */
export interface RoutesLogger {
	warn(fields: Record<string, unknown>, message: string): void;
}

export interface RoutesOptions {
	/** The checked `routing` block; without it every decision is what the host did before it existed. */
	routing?: ResolvedRouting | undefined;
	store: Pick<AgentDirectory, "agent" | "group">;
	/** The surfaces that host agent rooms, read each time: they are only known once the plugins linked. */
	roomSurfaces: () => readonly string[];
	/** The conversation an agent last ran a turn in. */
	latest?: (agent: string) => ChannelKey | undefined;
	logger?: RoutesLogger;
}

/** What the surfaces the host registered can hold, read when the agent server links. */
export interface LinkedSurfaces {
	/** Every registered surface. */
	names: readonly string[];
	/** Whether the agents have Discord channels. */
	discordChannels: boolean;
}

/**
 * The one table that says where an agent's work lands. An agent's *place* on a surface is its
 * Discord channel or its room there; its *primary place* is where work no person started lands.
 * Work a person started, or that waits on a person (a message, a card, a schedule's firing, an
 * exchange's answer), is never routed: it stays in the conversation they see. Every decision here
 * is what the host did before `routing` existed until the configuration says otherwise.
 */
export class Routes implements RoutingTable {
	readonly #routing: ResolvedRouting | undefined;
	readonly #options: RoutesOptions;
	readonly #warned = new Set<string>();

	constructor(options: RoutesOptions) {
		this.#options = options;
		this.#routing = options.routing;
	}

	/**
	 * The rules of one agent: its own over the `"*"` entry, over the defaults. A temp knight has
	 * no row of its own and follows its parent's, so it lives where its parent does.
	 */
	rules(agent: string): ResolvedAgentRoutes {
		const all = this.#routing?.agents;
		const parent = this.#options.store.agent(agent)?.parent;
		return {
			...all?.["*"],
			...(parent === undefined ? undefined : all?.[parent]),
			...all?.[agent],
		};
	}

	/**
	 * The agent's place on a surface (`"web"` for the one surface that hosts rooms); undefined when
	 * the agent is unknown or has none there.
	 */
	placeOn(name: string, surface: string): ChannelKey | undefined {
		const agent = this.#options.store.agent(name);
		if (!agent) return undefined;
		const rooms = this.#options.roomSurfaces();
		const wanted =
			surface === WEB && !rooms.includes(WEB) && rooms.length === 1
				? (rooms[0] as string)
				: surface;
		if (wanted === "discord")
			return agent.channelId ? discordKey(agent.channelId) : undefined;
		return rooms.includes(wanted) ? agentRoomKey(wanted, name) : undefined;
	}

	/**
	 * The agent's primary place, where its unprompted work lands: the surface its rules name, and
	 * with `"auto"` its Discord channel when it has one, else its room on the first surface that
	 * hosts rooms. An unknown agent has none. A named surface the agent has no place on is logged,
	 * and its auto place is used.
	 */
	primary(name: string): ChannelKey | undefined {
		if (!this.#options.store.agent(name)) return undefined;
		const wanted = this.rules(name).primary ?? "auto";
		if (wanted !== "auto") {
			const key = this.placeOn(name, wanted);
			if (key) return key;
			this.#warn(
				`primary:${name}`,
				{ agent: name, surface: wanted },
				"the agent has no place on its primary surface; its auto place is used",
			);
		}
		return keysOf(this.#options.store, name, this.#options.roomSurfaces())[0];
	}

	/**
	 * The conversation an event of `kind` for the agent lands in. `origin` is where it came in: the
	 * conversation of a webhook post (`integration`), the sender's turn channel (`agentMessage`), or
	 * the conversation that asked for the agent (`opening`). A destination that has vanished sends
	 * an `integration` event to its origin, with a warning, and never drops it. Throws AgentError
	 * when an `agentMessage` finds no place; undefined when an `opening` finds none.
	 */
	of(name: string, kind: "integration", origin: ChannelKey): ChannelKey;
	of(name: string, kind: "agentMessage", origin: ChannelKey): ChannelKey;
	of(
		name: string,
		kind: RouteKind,
		origin?: ChannelKey,
	): ChannelKey | undefined;
	of(
		name: string,
		kind: RouteKind,
		origin?: ChannelKey,
	): ChannelKey | undefined {
		if (kind === "integration") return this.#integration(name, origin);
		if (kind === "opening") return this.#opening(name, origin);
		return this.#agentMessage(name, origin);
	}

	#integration(
		name: string,
		origin: ChannelKey | undefined,
	): ChannelKey | undefined {
		const to = this.rules(name).integration ?? "origin";
		if (to === "origin" || origin === undefined) return origin;
		const key = to === "primary" ? this.primary(name) : this.placeOn(name, to);
		if (key) return key;
		this.#warn(
			`integration:${name}`,
			{ agent: name, to },
			"the agent has no place for its integrations; the report runs where the post was made",
		);
		return origin;
	}

	#opening(
		name: string,
		origin: ChannelKey | undefined,
	): ChannelKey | undefined {
		if (
			(this.rules(name).opening ?? "origin-surface") === "origin-surface" &&
			origin
		) {
			const key = this.placeOn(name, parseChannelKey(origin).surface);
			if (key) return key;
		}
		return this.primary(name);
	}

	/**
	 * The conversation a message to the agent lands in when the sender names none. By default
	 * (`"origin-surface"`) its place on the sender's own surface: its Discord channel for a message
	 * from Discord, its room for one from a room. `"latest"` is the conversation it last ran a turn
	 * in, but only on the sender's surface. A message never crosses surfaces by recency: when the
	 * agent has no place on the sender's surface, or no sender is known, it lands in the agent's
	 * primary place, and a crossing is logged with both surfaces.
	 */
	#agentMessage(name: string, from: ChannelKey | undefined): ChannelKey {
		const { latest } = this.#options;
		const to = this.rules(name).agentMessage ?? "origin-surface";
		if (to !== "latest" && to !== "origin-surface") {
			const key =
				to === "primary" ? this.primary(name) : this.placeOn(name, to);
			if (key) return key;
			this.#warn(
				`message:${name}`,
				{ agent: name, to },
				"the agent has no place for messages to it; its place on the sender's surface is used",
			);
		}
		const surface =
			from === undefined ? undefined : parseChannelKey(from).surface;
		if (to === "latest" && surface !== undefined) {
			const last = latest?.(name);
			const keys = keysOf(
				this.#options.store,
				name,
				this.#options.roomSurfaces(),
			);
			if (
				last !== undefined &&
				keys.includes(last) &&
				parseChannelKey(last).surface === surface
			)
				return last;
		}
		const own = surface === undefined ? undefined : this.placeOn(name, surface);
		if (own) return own;
		const primary = this.primary(name);
		if (!primary) throw new AgentError(`${name} has no channel yet.`);
		if (surface !== undefined)
			this.#warn(
				`message-cross:${name}:${surface}`,
				{
					agent: name,
					from: surface,
					to: parseChannelKey(primary).surface,
				},
				"the agent has no place on the sender's surface; the message lands in its primary place",
			);
		return primary;
	}

	/**
	 * Another agent's place for `schedule_list`: its room on the surface `near` is on when that
	 * surface hosts rooms, otherwise its primary place. Throws AgentError when it has none.
	 */
	near(name: string, near?: ChannelKey): ChannelKey {
		const surface = near === undefined ? undefined : roomSurfaceOf(near);
		const room =
			surface === undefined ? undefined : this.placeOn(name, surface);
		const key = room ?? this.primary(name);
		if (!key) throw new AgentError(`${name} has no channel yet`);
		return key;
	}

	/**
	 * A named destination of the host (`ops`): its conversation, or the primary place of the agent
	 * it names while that agent is active; undefined when none is configured or it has none now.
	 */
	place(name: string): ChannelKey | undefined {
		const target = this.#routing?.places[name];
		if (target === undefined) return undefined;
		if (typeof target === "string") return target;
		return this.#options.store.agent(target.agent)?.status === "active"
			? this.primary(target.agent)
			: undefined;
	}

	/**
	 * Refuses a surface the rules name that is not registered, or that cannot hold an agent's place,
	 * naming the key and the fix; called once every plugin has registered its surfaces.
	 */
	validate(linked: LinkedSurfaces): void {
		if (!this.#routing) return;
		const rooms = this.#options.roomSurfaces();
		const holders = [...(linked.discordChannels ? ["discord"] : []), ...rooms];
		for (const [agent, rules] of Object.entries(this.#routing?.agents ?? {}))
			for (const key of ["primary", "integration", "agentMessage"] as const) {
				const surface = rules[key];
				if (
					surface === undefined ||
					(ROUTE_WORDS[key] as readonly string[]).includes(surface)
				)
					continue;
				const path = `routing.agents.${agent}.${key}`;
				if (surface === WEB && !linked.names.includes(WEB)) {
					if (rooms.length !== 1)
						throw new ConfigError(
							`config ${path}: "web" stands for the one surface that hosts rooms, and ${rooms.length === 0 ? "none does" : `${rooms.length} do (${rooms.join(", ")})`}. Name the surface: ${holders.join(", ") || "none hosts agent places on this host"}.`,
						);
					continue;
				}
				if (!linked.names.includes(surface))
					throw new ConfigError(
						`config ${path}: no surface is registered as ${JSON.stringify(surface)}. The registered surfaces are ${linked.names.join(", ") || "none"}; name one of them, or add the plugin that brings ${JSON.stringify(surface)}.`,
					);
				if (!holders.includes(surface))
					throw new ConfigError(
						`config ${path}: the ${surface} surface holds no agent places, since it hosts no rooms${surface === "discord" ? " here (the agents have no Discord channels)" : ""}. Name one that does: ${holders.join(", ") || "none on this host"}.`,
					);
			}
	}

	/**
	 * Warns of the agents the rules and places name that the team does not know yet, which may be
	 * created later: their rules apply once they exist.
	 */
	warnUnknown(): void {
		const names = [
			...Object.keys(this.#routing?.agents ?? {}).filter((n) => n !== "*"),
			...Object.values(this.#routing?.places ?? {}).flatMap((t) =>
				typeof t === "object" ? [t.agent] : [],
			),
		];
		const unknown = [...new Set(names)].filter(
			(n) => !this.#options.store.agent(n),
		);
		if (unknown.length > 0)
			this.#options.logger?.warn(
				{ agents: unknown },
				"routing names agents the team does not have yet; their rules apply once they exist",
			);
	}

	/** Warns once per key, so a repeated event does not flood the log. */
	#warn(key: string, fields: Record<string, unknown>, message: string): void {
		if (this.#warned.has(key)) return;
		this.#warned.add(key);
		this.#options.logger?.warn(fields, message);
	}
}

/** The routing table of a team's options: the host's own, or, without one, the defaults. */
export function routesOf(options: {
	routes?: Routes | undefined;
	store: RoutesOptions["store"] & {
		conversations: { latest(agent: string): ChannelKey | undefined };
	};
	surfaces?: { roomSurfaces(): readonly string[] } | undefined;
	logger: RoutesLogger;
}): Routes {
	return (
		options.routes ??
		new Routes({
			store: options.store,
			roomSurfaces: () => options.surfaces?.roomSurfaces() ?? [],
			latest: (agent) => options.store.conversations.latest(agent),
			logger: options.logger,
		})
	);
}
