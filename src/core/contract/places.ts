import type { TSchema } from "typebox";
import type {
	IntercomCard,
	PostAuthor,
	ReplyFile,
} from "../domain/conversation.ts";
import type { InterimPosts } from "../domain/interim.ts";
import type { ChannelKey } from "../domain/sessions.ts";
import { channelKey, parseChannelKey } from "./surface.ts";

/** What a place belongs to. */
export type PlaceKind = "agent" | "group";

export interface PlaceRef {
	kind: PlaceKind;
	name: string;
}

/** Who speaks in a post: the agent's name and look. */
export interface PlaceAuthor extends PostAuthor {
	avatarUrl: string;
}

/** One agent post in a place; what a Discord channel post and a room's `OutboundReply` carry. */
export interface PlacePost {
	author: PlaceAuthor;
	thinking?: string;
	chunks: string[];
	files?: ReplyFile[];
	/** A thread of the place to post in instead, such as a dispatch's. */
	thread?: string;
	intercom?: IntercomCard;
	failed?: true;
}

/** What `ensure` makes or brings back a place for. */
export interface PlaceSpec extends PlaceRef {
	displayName: string;
	/** An agent's display name; a group's members and host on one line. */
	topic: string;
	/** A temp knight's parent's place id on this surface: the place is made under it (a Discord thread). */
	parent?: string;
	/** The stored id of an archived or checked place, to bring back instead of making a new one. */
	existing?: string;
	/** The values of this provider's `createArguments` the creating tool was given, such as `category`. */
	hints?: Readonly<Record<string, string>>;
}

/** What `check` finds of a stored place at start. */
export type PlaceCheck = "ok" | "gone" | "foreign";

/** An argument a provider adds to a creation tool: a Typebox schema, with its description in the schema. */
export type ToolArgument = TSchema;

/**
 * What a chat surface holds of the team's places: where an agent or group is spoken to on it.
 * The members a minimal provider needs are `surface`, `storage`, `key`, `placeOf` and `post`; the
 * rest are optional capabilities. A plugin contributes providers with `places`; a surface that
 * hosts agent rooms (`agentRooms: true`) and has no provider gets a derived one from the host.
 */
export interface PlaceProvider {
	/** The surface whose keys this provider's places have; one provider per surface. */
	readonly surface: string;
	/** `derived`: the place exists with the name and nothing is stored. `stored`: the place has an id of the surface's own, which the team keeps. */
	readonly storage: "derived" | "stored";
	/** The key of a place: from the name when derived, from `id` when stored (which a stored provider requires). */
	key(ref: PlaceRef, id?: string): ChannelKey;
	/** Which place a key of this surface is: the ref of a derived one, the id of a stored one; undefined for a key that is none of this provider's. */
	placeOf(key: ChannelKey): PlaceRef | { id: string } | undefined;
	/** Posts under the author's name and look. */
	post(key: ChannelKey, post: PlacePost): Promise<void>;
	/** The running turn's interim posts under the author; absent = final replies only. */
	interim?(key: ChannelKey, author: PlaceAuthor): InterimPosts | undefined;
	/** Stored: makes the place, or brings `existing` back (out of an archive, a closed thread reopened); resolves to its id. Absent = places are bound, never made. */
	ensure?(spec: PlaceSpec): Promise<string>;
	/** Stored: the owner was archived; the place is kept with its history where nobody answers. Resolves to a line for the archive tool's answer, or undefined. */
	remove?(
		id: string,
		spec: PlaceSpec & { helper: boolean },
	): Promise<string | undefined>;
	/** Stored, at start: `gone` archives the owner as a deletion would; `foreign` (the id is no place of this provider's space, such as a channel of a guild the team left) drops the row, and `ensure` makes a new one. */
	check?(id: string): Promise<PlaceCheck>;
	/** Writes a group's topic; never awaited by a turn. */
	describe?(id: string, topic: string): Promise<void>;
	/** Reports a place deleted on the surface; its owner is archived. Register during setup. */
	onRemoved?(listener: (id: string) => void): void;
	/** The space (a Discord guild) whose every channel belongs to the team: unaddressed ones are the owner's notes and go unanswered. */
	readonly space?: string;
	/** How the model names a place in text, such as `<#id>`; default the key. */
	mention?(key: ChannelKey): string;
	/** The conversation keys of a stored group's seats and log, for a provider that must keep forms already in use. Default `agentgroup:<surface>.<id>.<agent>` and `<group>@<surface>`. */
	conversations?: {
		seat(groupId: string, agent: string): ChannelKey;
		log(group: string): string;
	};
	/** The id of the place whose agent is the coordinator, such as Discord's entry channel; absent = the configured `coordinator`. */
	readonly coordinatorPlace?: string;
	/** Arguments this provider adds to `agent_create` and `group_create`; their values reach `ensure` as `hints`. */
	createArguments?: {
		agent?: Readonly<Record<string, ToolArgument>>;
		group?: Readonly<Record<string, ToolArgument>>;
	};
	/** A section of `agent_list` after the team, such as Discord's categories in server order. */
	layoutText?(): Promise<string | undefined>;
}

/**
 * Every place provider of the host, chosen by a surface or a channel key. Calls during setup
 * throw NotLinkedError, because the providers are collected once every plugin is set up.
 */
export interface PlacePort {
	/** The provider of a surface by name, or of a channel key by its prefix; undefined when none serves it. */
	of(surfaceOrKey: string): PlaceProvider | undefined;
	/** The stored providers, in contribution order. */
	stored(): readonly PlaceProvider[];
	/** Every provider in the order "auto" prefers: the stored ones in contribution order, then the derived ones in surface order. */
	all(): readonly PlaceProvider[];
}

const ROOM_ID = /^(agent|group)\.([a-z0-9-]{1,32})$/;

/** The key of an agent's or group's room on a surface: `<surface>:agent.<name>` or `<surface>:group.<name>`. */
export const roomKey = (surface: string, ref: PlaceRef): ChannelKey =>
	channelKey(surface, `${ref.kind}.${ref.name}`);

/**
 * Which agent's or group's room a key of `surface` is, when its id has the exact shape of a room;
 * undefined for any other key, so no other key is ever taken for one.
 */
export function roomRef(
	key: ChannelKey,
	surface: string,
): PlaceRef | undefined {
	const at = typeof key === "string" ? key.indexOf(":") : -1;
	if (at <= 0) return undefined;
	const parsed = parseChannelKey(key);
	if (parsed.surface !== surface) return undefined;
	const match = ROOM_ID.exec(parsed.id);
	if (!match) return undefined;
	return { kind: match[1] as PlaceKind, name: match[2] as string };
}
