import type { StoredPlace } from "../agents/agent-places.ts";
import { type StoredPlaces, TeamPlaces } from "../agents/team-places.ts";
import type { AgentChannels } from "../contract/agent-channels.ts";
import type { PlacePort, PlaceProvider } from "../contract/places.ts";
import type { SurfacePort } from "../contract/surface.ts";
import { discordPlaces } from "../discord/agent-places.ts";
import {
	type DiscordAgentToolsOptions,
	discordChannelOps,
} from "../discord/agent-tools.ts";
import {
	type FakeServer,
	fakeDiscordClient,
} from "../discord/place-fake-client.ts";
import { silentLogger } from "../kernel/log.ts";
import type { FormerChannelOps } from "../plugin-api/agent-ops.ts";
import { derivedPlaces } from "../registry/place-port.ts";

/** The surface of the legacy channel columns: what a store's `channelId` is a place on. */
const LEGACY = "discord";

/** The stored places of the given rows, read each time, so a test may change them. */
export function storedFrom(rows: () => readonly StoredPlace[]): StoredPlaces {
	return {
		on: (kind, name, surface) =>
			rows().find(
				(row) =>
					row.kind === kind && row.name === name && row.surface === surface,
			)?.externalId,
		ownerOf: (surface, externalId) => {
			const row = rows().find(
				(r) => r.surface === surface && r.externalId === externalId,
			);
			return row && { kind: row.kind, name: row.name };
		},
	};
}

/** The Discord rows a store's `channelId` columns stand for. */
export function legacyRows(
	agents: readonly { name: string; channelId?: string | undefined }[],
	groups: readonly { name: string; channelId?: string | undefined }[] = [],
): StoredPlace[] {
	const row = (
		kind: StoredPlace["kind"],
		owner: { name: string; channelId?: string | undefined },
	): StoredPlace[] =>
		owner.channelId === undefined
			? []
			: [
					{
						kind,
						name: owner.name,
						surface: LEGACY,
						externalId: owner.channelId,
					},
				];
	return [
		...agents.flatMap((a) => row("agent", a)),
		...groups.flatMap((g) => row("group", g)),
	];
}

/** The guild the stand-in Discord's agent channels live in. */
export const TEST_AGENT_GUILD = "900000000000000001";

/** What a stand-in Discord's provider asks of the server it stands on. */
export interface TestDiscord {
	/** The agent channels the provider makes and moves; absent = a provider that is only read. */
	channels?: AgentChannels;
	/** Answers the provider's `check`, as the server does; absent = no `check`. */
	server?: Omit<FakeServer, "guild">;
	/** Where the provider registers the listener of a deleted channel. */
	onRemoved?: (listener: (channelId: string) => void) => void;
	/** The agent or group whose channel it is, for the category listing; absent = a mention. */
	nameOf?: (channelId: string) => string | undefined;
}

/**
 * Discord's own provider, with the keys and forms a host gives it, over the channels and server a
 * test hands; without them it only reads places.
 */
export function discordTestPlaces(
	guild = TEST_AGENT_GUILD,
	over: TestDiscord = {},
): PlaceProvider {
	return discordPlaces({
		// SAFETY: a provider that is only read never asks the client or the channels.
		client: over.server
			? fakeDiscordClient({ guild, ...over.server })
			: (undefined as never),
		guild,
		channels: over.channels ?? (undefined as never),
		onRemoved: over.onRemoved ?? (() => undefined),
		...(over.nameOf ? { nameOf: over.nameOf } : {}),
		logger: silentLogger(),
	});
}

/** Discord's side of the team's deprecated `arrange` and `read`, as a host hands it with a guild. */
export function discordTestChannelOps(
	channels: AgentChannels,
	directory: DiscordAgentToolsOptions["directory"] extends () => infer D
		? NonNullable<D>
		: never,
): FormerChannelOps {
	return discordChannelOps({
		channels,
		directory: () => directory,
		logger: silentLogger(),
	});
}

/**
 * A port over the providers a test names: `stored` first, then a derived provider for each of
 * `rooms`, both read each time, so a test may change the surfaces that host rooms.
 */
export function testPlacePort(options: {
	rooms?: () => readonly string[];
	stored?: () => readonly PlaceProvider[];
	/** What the derived providers post through; absent = a post fails. */
	surfaces?: SurfacePort;
}): PlacePort {
	const surfaces =
		options.surfaces ??
		// SAFETY: only a post reads it, and a test that posts gives its own.
		(undefined as never);
	const all = () => [
		...(options.stored?.() ?? []),
		...(options.rooms?.() ?? []).map((surface) =>
			derivedPlaces(surface, surfaces),
		),
	];
	return {
		of: (surfaceOrKey) => {
			const at = surfaceOrKey.indexOf(":");
			if (at === 0) return undefined;
			const surface = at < 0 ? surfaceOrKey : surfaceOrKey.slice(0, at);
			return all().find((p) => p.surface === surface);
		},
		stored: () => options.stored?.() ?? [],
		all,
	};
}

/**
 * The places of a team over fakes: Discord's provider when `discord` (over `channels`, which it
 * posts through), a room on each of `rooms` (posting through `surfaces`), and `stored` rows.
 */
export function testPlaces(options: {
	store: ConstructorParameters<typeof TeamPlaces>[0];
	rows?: () => readonly StoredPlace[];
	rooms?: () => readonly string[];
	discord?: boolean;
	/** The channels Discord's provider posts through; absent = it only reads places. */
	channels?: Partial<AgentChannels>;
	/** What the rooms' derived providers post through; absent = a post fails. */
	surfaces?: Partial<SurfacePort>;
	stored?: () => readonly PlaceProvider[];
}): TeamPlaces {
	const discord =
		options.discord === false
			? []
			: [
					discordTestPlaces(
						TEST_AGENT_GUILD,
						options.channels
							? { channels: options.channels as AgentChannels }
							: {},
					),
				];
	return new TeamPlaces(
		options.store,
		storedFrom(options.rows ?? (() => [])),
		testPlacePort({
			...(options.rooms ? { rooms: options.rooms } : {}),
			...(options.surfaces
				? { surfaces: options.surfaces as SurfacePort }
				: {}),
			stored: () => [...discord, ...(options.stored?.() ?? [])],
		}),
	);
}

/** The `spaceOf` of an agent claim whose Discord channels live in `guild`: the space of every Discord key, none for another surface's. */
export const discordSpaceOf =
	(guild: string | undefined) =>
	(channel: string): string | undefined =>
		channel.startsWith("discord:") ? guild : undefined;
