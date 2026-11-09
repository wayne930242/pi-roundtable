import {
	type PlaceKind,
	type PlacePort,
	type PlaceProvider,
	type PlaceRef,
	roomKey,
} from "../contract/places.ts";
import { parseChannelKey } from "../contract/surface.ts";
import type { ChannelKey } from "../domain/conversation.ts";
import { AgentError } from "../domain/errors.ts";
import type { AgentTurnScope } from "../domain/ports.ts";
import type { AgentDirectory } from "../plugin-api/services.ts";
import type { AgentPlaces } from "./agent-places.ts";
import type { Agent, AgentGroup } from "./agent-rules.ts";

/** The part of the stored places the team reads: an owner's place id on a surface, and the owner of a place id. */
export type StoredPlaces = Pick<AgentPlaces, "on" | "ownerOf">;

/** Whose place a key is. */
export interface PlaceOwner {
	kind: PlaceKind;
	name: string;
	/** A stored place keeps its owner's row when the owner is archived, so it names an archived owner too; a room does not. */
	stored: boolean;
}

/** One place of an agent or group, as a surface and the key of its conversation there. */
export interface TeamPlace {
	surface: string;
	key: ChannelKey;
}

/**
 * Where the team's agents and groups are, read through the place providers of the host: their keys,
 * who owns a key, and the conversation keys of a group's seats and log. A stored provider's places
 * are the rows of `agent_places`; a derived provider's are rooms named after the agent or group.
 * A surface with no provider on this host has no place here, whatever rows are stored for it.
 *
 * "Auto" order is the port's: the stored providers in contribution order, then the derived ones.
 * Call it only once the host has linked (the port throws NotLinkedError before): a team reads it
 * from its start on.
 */
export class TeamPlaces {
	readonly #store: Pick<AgentDirectory, "agent" | "group">;
	readonly #stored: StoredPlaces;
	readonly #port: PlacePort | undefined;

	/** `port` absent: a team nobody can reach has no places at all. */
	constructor(
		store: Pick<AgentDirectory, "agent" | "group">,
		stored: StoredPlaces,
		port: PlacePort | undefined,
	) {
		this.#store = store;
		this.#stored = stored;
		this.#port = port;
	}

	/** The providers in "auto" order. */
	providers(): readonly PlaceProvider[] {
		return this.#port?.all() ?? [];
	}

	/** The surfaces that hold places, in "auto" order. */
	surfaces(): readonly string[] {
		return this.providers().map((provider) => provider.surface);
	}

	/** The surfaces whose places are rooms named after the agent or group. */
	rooms(): readonly string[] {
		return this.providers().flatMap((provider) =>
			provider.storage === "derived" ? [provider.surface] : [],
		);
	}

	/** The provider of a surface by name, or of a key by its prefix. */
	providerOf(surfaceOrKey: string): PlaceProvider | undefined {
		return this.#port?.of(surfaceOrKey);
	}

	/** The surface of a key that is a room's, or no provider's: any key but a stored place's. */
	roomSurfaceOf(key: ChannelKey): string | undefined {
		if (typeof key !== "string" || !key.includes(":")) return undefined;
		return this.#provider(key)?.storage === "stored"
			? undefined
			: parseChannelKey(key).surface;
	}

	/** Whether the key is a stored place's: one a provider made or bound. */
	isStored(key: ChannelKey): boolean {
		return this.#provider(key)?.storage === "stored";
	}

	/** The space of the provider of the key's surface; a message from it is the team's even outside the places it knows. */
	spaceOf(key: ChannelKey): string | undefined {
		return this.#provider(key)?.space;
	}

	/** How the model names the place in text: the provider's mention, else the key. */
	mention(key: ChannelKey): string {
		return this.#provider(key)?.mention?.(key) ?? key;
	}

	/** The agent's or group's name as a place owner; an agent first, since names are shared. */
	#ref(name: string): PlaceRef | undefined {
		if (this.#store.agent(name)) return { kind: "agent", name };
		if (this.#store.group(name)) return { kind: "group", name };
		return undefined;
	}

	#keyOn(ref: PlaceRef, provider: PlaceProvider): ChannelKey | undefined {
		if (provider.storage === "derived") return provider.key(ref);
		const id = this.#stored.on(ref.kind, ref.name, provider.surface);
		return id === undefined ? undefined : provider.key(ref, id);
	}

	/**
	 * Every key an agent or group is addressed by, in "auto" order: the places it has on each
	 * provider's surface. Archived ones count, so what they left behind can be cleared; none for a
	 * name the team does not know.
	 */
	keysOf(name: string): ChannelKey[] {
		return this.placesOf(name).map((place) => place.key);
	}

	/** The places of an agent or group, each with its surface, in "auto" order. */
	placesOf(name: string): TeamPlace[] {
		const ref = this.#ref(name);
		if (!ref) return [];
		return this.providers().flatMap((provider) => {
			const key = this.#keyOn(ref, provider);
			return key === undefined ? [] : [{ surface: provider.surface, key }];
		});
	}

	/** The agent's place on a surface, or undefined when it has none there. */
	placeOn(name: string, surface: string): ChannelKey | undefined {
		const ref = this.#ref(name);
		const provider = this.providerOf(surface);
		return ref && provider ? this.#keyOn(ref, provider) : undefined;
	}

	#provider(key: ChannelKey): PlaceProvider | undefined {
		return typeof key === "string" && key.includes(":")
			? this.#port?.of(key)
			: undefined;
	}

	/** Whose place a key is, whatever the owner's status; undefined for a key no provider of this host reads as one, and for an owner the team does not have. */
	ownerOf(key: ChannelKey): PlaceOwner | undefined {
		const provider = this.#provider(key);
		const place = provider?.placeOf(key);
		if (!provider || !place) return undefined;
		const stored = "id" in place;
		const owner = stored
			? this.#stored.ownerOf(provider.surface, place.id)
			: place;
		if (!owner) return undefined;
		const found =
			owner.kind === "agent"
				? this.#store.agent(owner.name)
				: this.#store.group(owner.name);
		return found && { kind: owner.kind, name: owner.name, stored };
	}

	/**
	 * The agent whose place the key is. A stored place keeps its row while its owner is archived,
	 * and an archived agent owns nothing there; a room names an archived agent too, so what it
	 * left behind can be found.
	 */
	agentOf(key: ChannelKey): Agent | undefined {
		const owner = this.ownerOf(key);
		if (owner?.kind !== "agent") return undefined;
		const agent = this.#store.agent(owner.name);
		return owner.stored && agent?.status !== "active" ? undefined : agent;
	}

	/** The group whose place the key is, under the same rule as `agentOf`. */
	groupOf(key: ChannelKey): AgentGroup | undefined {
		const owner = this.ownerOf(key);
		if (owner?.kind !== "group") return undefined;
		const group = this.#store.group(owner.name);
		return owner.stored && group?.status !== "active" ? undefined : group;
	}

	/** What owns the key while active: an archived agent or group owns nothing. */
	ownerKind(key: ChannelKey): PlaceKind | undefined {
		const owner = this.ownerOf(key);
		if (!owner) return undefined;
		const found =
			owner.kind === "agent"
				? this.#store.agent(owner.name)
				: this.#store.group(owner.name);
		return found?.status === "active" ? owner.kind : undefined;
	}

	/**
	 * An agent's conversation inside a group. In a stored place of the group, the provider's form
	 * (`conversations.seat`, else `agentgroup:<surface>.<id>.<agent>`); in a room, or when the key is
	 * no provider's, `agentgroup:<surface>.group.<group>.<agent>`, so a room's seats are
	 * conversations of their own. Without `channel`, the group's first stored place. Throws
	 * AgentError for a group with no stored place there.
	 */
	seatKey(group: AgentGroup, agent: string, channel?: ChannelKey): ChannelKey {
		if (channel !== undefined) {
			const provider = this.#provider(channel);
			if (provider?.storage !== "stored")
				return roomSeat(parseChannelKey(channel).surface, group, agent);
			return this.#seatOn(group, agent, provider);
		}
		for (const provider of this.providers())
			if (
				provider.storage === "stored" &&
				this.#stored.on("group", group.name, provider.surface) !== undefined
			)
				return this.#seatOn(group, agent, provider);
		throw new AgentError(`the group ${group.name} has no place of its own`);
	}

	#seatOn(
		group: AgentGroup,
		agent: string,
		provider: PlaceProvider,
	): ChannelKey {
		const id = this.#stored.on("group", group.name, provider.surface);
		if (id === undefined)
			throw new AgentError(
				`the group ${group.name} has no place on ${provider.surface}`,
			);
		return (
			provider.conversations?.seat(id, agent) ??
			`agentgroup:${provider.surface}.${id}.${agent}`
		);
	}

	/** Every conversation of an agent's seat in a group: one on each stored place of the group, then each room's. */
	seatsOf(group: AgentGroup, agent: string): ChannelKey[] {
		return this.providers().flatMap((provider) => {
			if (provider.storage === "derived")
				return [roomSeat(provider.surface, group, agent)];
			return this.#stored.on("group", group.name, provider.surface) ===
				undefined
				? []
				: [this.#seatOn(group, agent, provider)];
		});
	}

	/**
	 * The name a group's messages are logged under: in a stored place the provider's
	 * (`conversations.log`, else `<group>@<surface>`), in a room `<group>@<surface>`, so each
	 * conversation keeps its own history and cursors.
	 */
	logName(group: AgentGroup, channel: ChannelKey): string {
		const provider = this.#provider(channel);
		if (provider?.storage === "stored")
			return (
				provider.conversations?.log(group.name) ??
				`${group.name}@${provider.surface}`
			);
		return `${group.name}@${parseChannelKey(channel).surface}`;
	}

	/** An agent's conversation in the channel: its own place's, or its room's. */
	scopeOf(agent: Agent, channel: ChannelKey): AgentTurnScope {
		const home =
			this.#provider(channel)?.storage === "stored"
				? this.#ownKey(agent, channel)
				: channel;
		return { name: agent.name, session: home, home };
	}

	/**
	 * An agent's conversation inside a group: in a stored place of the group, or without a room,
	 * the seat of that place, whose home is the agent's own place on that surface; in a room, the
	 * room's seat, whose home is the agent's own room there.
	 */
	groupScope(
		agent: Agent,
		group: AgentGroup,
		room?: ChannelKey,
	): AgentTurnScope {
		const seat = this.seatKey(group, agent.name, room);
		const surface = room === undefined ? undefined : this.roomSurfaceOf(room);
		const ref: PlaceRef = { kind: "agent", name: agent.name };
		const home =
			surface === undefined
				? this.#ownKey(agent, room ?? seat)
				: roomKey(surface, ref);
		return { name: agent.name, session: seat, home, group: group.name };
	}

	/** The key of the agent's own place on the stored surface of `channel`, else on its first stored surface, else `channel`. */
	#ownKey(agent: Agent, channel: ChannelKey): ChannelKey {
		const wanted = this.#provider(channel);
		const ref: PlaceRef = { kind: "agent", name: agent.name };
		for (const provider of this.providers()) {
			if (provider.storage !== "stored") continue;
			if (wanted && provider.surface !== wanted.surface) continue;
			const key = this.#keyOn(ref, provider);
			if (key !== undefined) return key;
		}
		return channel;
	}

	/**
	 * The channel a group seat runs in outside a running turn: the group's room on the surface of
	 * the seat's home for a room seat, so it never falls out to the group's stored place; otherwise
	 * the group's place on the surface of the seat's home, or the seat's home.
	 */
	seatChannel(
		group: Pick<AgentGroup, "name">,
		scope: Pick<AgentTurnScope, "home">,
	): ChannelKey {
		const provider = this.#provider(scope.home);
		const ref: PlaceRef = { kind: "group", name: group.name };
		if (provider?.storage === "stored")
			return this.#keyOn(ref, provider) ?? scope.home;
		return roomKey(parseChannelKey(scope.home).surface, ref);
	}
}

/** A group's seat in its room on a surface: its own conversation, apart from the room's. */
const roomSeat = (
	surface: string,
	group: Pick<AgentGroup, "name">,
	agent: string,
): ChannelKey => `agentgroup:${surface}.group.${group.name}.${agent}`;
