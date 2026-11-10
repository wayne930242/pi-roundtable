import { type Client, DiscordAPIError } from "discord.js";
import { Type } from "typebox";
import type { AgentChannels } from "../contract/agent-channels.ts";
import type { PlaceCheck, PlaceProvider } from "../contract/places.ts";
import { channelKey, parseChannelKey } from "../contract/surface.ts";
import { AgentError } from "../domain/errors.ts";
import { PluginError } from "../kernel/errors.ts";
import type { Logger } from "../kernel/log.ts";
import {
	categoryKind,
	categoryLayoutText,
	teamCategory,
} from "./agent-layout.ts";
import type { DiscordConnection } from "./connection.ts";

const SURFACE = "discord";

/** Discord's error code for a channel that does not exist. */
const UNKNOWN_CHANNEL = 10003;

/** Discord's error code for a channel the bot may not see: one of a server it left, or a hidden one. */
const MISSING_ACCESS = 50001;

export interface DiscordPlacesOptions {
	/** The discord.js client that can ask Discord whether a stored channel still exists; without one the provider has no `check`, and a stored channel is taken as it is. */
	client?: Client;
	/** The agent guild: the only server whose channels are the team's places. */
	guild: string;
	channels: AgentChannels;
	/** Reports a server channel deleted, by id; as `DiscordConnection.onChannelDeleted`. */
	onRemoved(listener: (channelId: string) => void): void;
	logger: Logger;
	/** The channel the coordinator lives in; absent = the configured `coordinator`. */
	entryChannel?: string;
	/** The name of the agent or group whose channel it is, for `layoutText`; a channel nobody owns shows as a mention. */
	nameOf?(channelId: string): string | undefined;
}

const category = (kind: "Agents" | "Groups") =>
	Type.Optional(
		Type.String({
			description: `Discord only: the category its channel opens under, ${kind} (the default) or ${kind}-<suffix>, such as ${kind}-work; made when missing. Keep to the categories agent_list shows unless a new one fits better. The app's room groups follow group.`,
		}),
	);

/**
 * Discord's places: a channel for each agent and group in the agent guild, under the `Agents` or
 * `Groups` category, and a thread of its parent's channel for a temp knight. The channel's id is
 * the place's, and the keys, a group's seats and its log keep the forms they had before places
 * were providers, so no stored session, schedule or held action moves.
 */
export function discordPlaces(options: DiscordPlacesOptions): PlaceProvider {
	const { client, guild, channels, logger } = options;
	const mention = (id: string) => `<#${id}>`;
	const checkWith =
		(asked: Client) =>
		async (id: string): Promise<PlaceCheck> => {
			// Fetched fresh: a cached channel says nothing of one deleted since.
			const found = await asked.channels
				.fetch(id, { force: true })
				.catch(async (error: unknown) => {
					if (!(error instanceof DiscordAPIError)) throw error;
					if (error.code === UNKNOWN_CHANNEL) return "gone" as const;
					// Missing Access says nothing of whose guild the channel is in, so the agent guild's own
					// list does, which Discord gives whatever the overwrites: an id it does not hold is
					// another server's (the bot left it), and one it holds is a hidden channel of its own,
					// which stays a failure.
					if (error.code === MISSING_ACCESS) {
						const held = await (
							await asked.guilds.fetch(guild)
						).channels.fetch();
						if (!held.has(id)) return "foreign" as const;
					}
					throw error;
				});
			if (found === "gone" || found === "foreign") return found;
			// A channel discord.js cannot build is none of the agent guild's; only Discord's own "unknown" says gone.
			if (found === null) return "foreign";
			return !found.isDMBased() && found.guildId === guild ? "ok" : "foreign";
		};
	return {
		surface: SURFACE,
		storage: "stored",
		space: guild,
		...(options.entryChannel === undefined
			? {}
			: { coordinatorPlace: options.entryChannel }),
		key: (_ref, id) => {
			if (id === undefined)
				throw new PluginError("a Discord place is keyed by its channel id");
			return channelKey(SURFACE, id);
		},
		placeOf: (key) => {
			if (typeof key !== "string" || !key.includes(":")) return undefined;
			const parsed = parseChannelKey(key);
			return parsed.surface === SURFACE ? { id: parsed.id } : undefined;
		},
		post: (key, post) =>
			channels.post(parseChannelKey(key).id, {
				name: post.author.name,
				avatarUrl: post.author.avatarUrl,
				...(post.thinking ? { thinking: post.thinking } : {}),
				chunks: post.chunks,
				...(post.files?.length ? { files: post.files } : {}),
				...(post.thread === undefined ? {} : { threadId: post.thread }),
				...(post.intercom ? { intercom: post.intercom } : {}),
			}),
		interim: (key, author) =>
			channels.interim?.(parseChannelKey(key).id, {
				name: author.name,
				avatarUrl: author.avatarUrl,
			}),
		ensure: async (spec) => {
			// A temp knight's place is a thread of its parent's channel, opened again when it is kept.
			if (spec.parent !== undefined) {
				if (
					spec.existing !== undefined &&
					channels.openThread &&
					(await channels.exists(spec.existing))
				) {
					await channels.openThread(spec.existing);
					return spec.existing;
				}
				if (!channels.createThread)
					throw new AgentError("this Discord connection makes no threads");
				return channels.createThread(spec.parent, spec.displayName);
			}
			const kind = spec.kind === "agent" ? "Agents" : "Groups";
			const under = teamCategory(spec.hints?.category, kind);
			if (
				spec.existing !== undefined &&
				(await channels.exists(spec.existing))
			) {
				// A channel already under a category of its kind (`Groups-Work`) stays there unless a category is asked for.
				if (spec.hints?.category === undefined) {
					const { existing } = spec;
					const home = (await channels.layout()).find((c) =>
						c.channelIds.includes(existing),
					);
					if (home && categoryKind(home.name) === kind) return existing;
				}
				await channels.placeIn(spec.existing, under);
				return spec.existing;
			}
			return channels.createChannel(spec.name, spec.topic, under);
		},
		remove: async (id, spec) => {
			// A thread is closed rather than moved; one that will not close stays silent where it is.
			if (spec.helper) {
				try {
					await channels.closeThread?.(id);
				} catch (error) {
					logger.warn(
						{ agent: spec.name, err: error },
						"temp knight's thread not closed; it stays silent where it is",
					);
				}
				return undefined;
			}
			try {
				await channels.removeWebhook(id);
			} catch (error) {
				logger.warn(
					{ name: spec.name, err: error },
					"archived channel's webhook not removed",
				);
			}
			try {
				await channels.placeIn(id, "Archive");
			} catch (error) {
				logger.error(
					{ name: spec.name, err: error },
					"archived channel not moved",
				);
				return `, but its channel ${mention(id)} could not be moved to Archive (${error instanceof Error ? error.message : String(error)}); it stays silent where it is.`;
			}
			return `; its channel ${mention(id)} is kept under Archive.`;
		},
		...(client ? { check: checkWith(client) } : {}),
		describe: (id, topic) => channels.setTopic(id, topic),
		onRemoved: (listener) => options.onRemoved(listener),
		mention: (key) => mention(parseChannelKey(key).id),
		// The forms Discord's groups have always had, so their sessions and logs carry over.
		conversations: {
			seat: (groupId, agent) => `agentgroup:${groupId}.${agent}`,
			log: (group) => group,
		},
		createArguments: {
			agent: { category: category("Agents") },
			group: { category: category("Groups") },
		},
		layoutText: async () =>
			categoryLayoutText(await channels.layout(), (id) => options.nameOf?.(id)),
	};
}

export interface DiscordPlaceProviderOptions {
	/** The agent guild: the only server whose channels are the team's places. */
	guild: string;
	/** The Discord the host uses, as `DISCORD` provides it: the provider reads the guild's channels and deleted channels from it. */
	connection: Pick<DiscordConnection, "agentChannels" | "onChannelDeleted">;
	logger: Logger;
	/** The discord.js client, so the team can check at start that its stored channels still exist; absent = they are taken as they are. */
	client?: Client;
	/** The channel the coordinator lives in (`discord.entryChannel`); absent = the configured `coordinator`. */
	entryChannel?: string;
}

/**
 * Discord's place provider for a plugin that replaces `DISCORD` with a Discord of its own: the
 * agent guild's channels as the team's places, with the keys, seats and log names the built-in
 * Discord plugin gives them, so no stored session, schedule or held action moves. Contribute it
 * with `places` from the replacing plugin whenever the host has `discord.guild`.
 */
export function discordPlaceProvider(
	options: DiscordPlaceProviderOptions,
): PlaceProvider {
	const { guild, connection } = options;
	return discordPlaces({
		...(options.client ? { client: options.client } : {}),
		...(options.entryChannel === undefined
			? {}
			: { entryChannel: options.entryChannel }),
		guild,
		channels: connection.agentChannels(guild),
		onRemoved: (listener) => connection.onChannelDeleted(listener),
		logger: options.logger,
	});
}
