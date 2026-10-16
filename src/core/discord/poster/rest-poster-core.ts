import { type REST, Routes } from "discord.js";
import { DiscordPosterError, failure } from "./poster-errors.ts";

/** The options of discord.js' REST client that the poster uses. */
export interface RestOptions {
	body?: unknown;
	files?: readonly { name: string; data: Uint8Array; contentType?: string }[];
	query?: URLSearchParams;
	/** `false` sends no bot token: a webhook is addressed by its own token. */
	auth?: boolean;
	/** Gives up on the request when it fires (a call that discord.js would otherwise hold for a rate limit). */
	signal?: AbortSignal;
}

/** The part of discord.js' `REST` the poster calls, so a test can answer without a network. */
export interface DiscordRest {
	get(route: `/${string}`, options?: RestOptions): Promise<unknown>;
	post(route: `/${string}`, options?: RestOptions): Promise<unknown>;
	patch(route: `/${string}`, options?: RestOptions): Promise<unknown>;
	put(route: `/${string}`, options?: RestOptions): Promise<unknown>;
	delete(route: `/${string}`, options?: RestOptions): Promise<unknown>;
}

function mutable(options: RestOptions | undefined) {
	if (!options) return undefined;
	const { files, ...rest } = options;
	return { ...rest, ...(files ? { files: [...files] } : {}) };
}

/** The poster's view of a discord.js REST client. The token stays inside the client. */
export function restOf(rest: REST): DiscordRest {
	return {
		get: (route, options) => rest.get(route, mutable(options)),
		post: (route, options) => rest.post(route, mutable(options)),
		patch: (route, options) => rest.patch(route, mutable(options)),
		put: (route, options) => rest.put(route, mutable(options)),
		delete: (route, options) => rest.delete(route, mutable(options)),
	};
}

export function object(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

export function text(value: unknown): string | undefined {
	return typeof value === "string" && value !== "" ? value : undefined;
}

/** What the poster's two halves share: the REST client, the bot's id and the channels already read. */
export interface RestCore {
	rest: DiscordRest;
	/** The bot's own user id, read on first use. */
	bot(): Promise<string>;
	/** A channel's guild and type; neither changes, so they are kept. */
	readChannel(channelId: string): Promise<{ guildId: string; type: unknown }>;
	/** The guild of a category; fails when the channel is no category. */
	guildOf(categoryId: string): Promise<string>;
}

export function restCore(rest: DiscordRest): RestCore {
	let botId: Promise<string> | undefined;
	const bot = (): Promise<string> => {
		botId ??= rest
			.get(Routes.user())
			.then((me) => {
				const id = text(object(me).id);
				if (!id) throw new DiscordPosterError("rejected", "the bot has no id");
				return id;
			})
			.catch((error: unknown) => {
				// A failed read is asked again by the next call.
				botId = undefined;
				throw failure("reading the bot", error);
			});
		return botId;
	};
	// A channel's guild and type never change; neither is a secret.
	const known = new Map<string, { guildId: string; type: unknown }>();
	const readChannel = async (channelId: string) => {
		const held = known.get(channelId);
		if (held) return held;
		const channel = object(
			await rest.get(Routes.channel(channelId)).catch((error: unknown) => {
				throw failure("reading a channel", error);
			}),
		);
		const guildId = text(channel.guild_id);
		if (!guildId)
			throw new DiscordPosterError("invalid", "that channel is in no guild", {
				reason: "wrong_guild",
			});
		const read = { guildId, type: channel.type };
		known.set(channelId, read);
		return read;
	};
	const guildOf = async (categoryId: string): Promise<string> => {
		const category = await readChannel(categoryId);
		// 4 is a category channel; anything else is not a place to put channels.
		if (category.type !== 4)
			throw new DiscordPosterError(
				"invalid",
				"that channel is not a category",
				{
					reason: "not_category",
				},
			);
		return category.guildId;
	};
	return { rest, bot, readChannel, guildOf };
}
