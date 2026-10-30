import {
	either,
	type Field,
	integer,
	list,
	optional,
	shape,
	text,
} from "../config/schema.ts";
import type { InboundMessage } from "../contract/channels.ts";
import { parseChannelKey } from "../contract/surface.ts";
import { ConfigError } from "../domain/errors.ts";
import type { ChannelKey } from "../sessions.ts";

/** One peer bot the host answers, and where. */
export interface PeerBotEntry {
	/** The bot's user id on the surface, a Discord snowflake. */
	id: string;
	/** Answer it only in these servers; left out, in every server of the host. */
	guilds?: readonly string[];
	/** Answer it only in these channels; left out, in every channel. */
	channels?: readonly string[];
}

/**
 * The other bots whose messages the host answers like a guest's. Explicit ids only: there is no
 * wildcard and no "all bots", and a host that leaves this out answers no bot.
 */
export interface PeerBotsConfig {
	/** The peer bots, each by its user id or as an entry that limits it to servers or channels. */
	allow: readonly (string | PeerBotEntry)[];
	/**
	 * The most messages from peer bots in a row, in one channel, that start a turn before the next
	 * one is ignored; a person's message in the channel starts the count over. Default 3.
	 */
	maxRounds?: number;
}

/** The rounds in a row a channel answers peer bots when the host does not say. */
export const DEFAULT_PEER_ROUNDS = 3;

const SNOWFLAKE = /^[0-9]{17,20}$/;

/** A Discord id: 17 to 20 digits. */
const snowflake: Field<string> = {
	describe: "a Discord id (17 to 20 digits)",
	check: (value, path) => {
		const id = text.check(value, path);
		if (!SNOWFLAKE.test(id))
			throw new ConfigError(
				`config ${path}: expected a Discord id (17 to 20 digits), got ${JSON.stringify(id)}. Copy the id with Developer Mode on; a name or a wildcard is not accepted. Fix the value in roundtable.config.ts.`,
			);
		return id;
	},
};

const entryShape = shape({
	id: snowflake,
	guilds: optional(list(snowflake)),
	channels: optional(list(snowflake)),
});

/** `discord.peerBots`, or the `peerBots` of the host's options. */
export const peerBotsShape = shape({
	allow: list(either(snowflake, entryShape)),
	maxRounds: optional(integer(1, 100)),
});

/**
 * The peer bots a host answers, and how many of their messages in a row a channel answers.
 * Core-internal: the router holds it, and a claim reads only `InboundMessage.peerBot`.
 */
export class PeerBots {
	readonly #entries: ReadonlyMap<string, readonly PeerBotEntry[]>;
	readonly #maxRounds: number;
	readonly #surface: string;
	/** Peer messages answered since a person last posted, by channel. */
	readonly #rounds = new Map<ChannelKey, number>();

	/** Throws a ConfigError naming `at` for an id that is not a snowflake. */
	constructor(config: PeerBotsConfig, surface = "discord", at = "peerBots") {
		const checked = peerBotsShape.check(config, at);
		const entries = new Map<string, PeerBotEntry[]>();
		for (const given of checked.allow) {
			const entry = typeof given === "string" ? { id: given } : given;
			entries.set(entry.id, [...(entries.get(entry.id) ?? []), entry]);
		}
		this.#entries = entries;
		this.#maxRounds = checked.maxRounds ?? DEFAULT_PEER_ROUNDS;
		this.#surface = surface;
	}

	/** Whether the host lists the bot that wrote this message, for this channel and server. */
	lists(message: InboundMessage): boolean {
		if (!message.authorIsBot || message.integration) return false;
		const { surface, id: channelId } = parseChannelKey(message.channel);
		if (surface !== this.#surface) return false;
		return (this.#entries.get(message.authorId) ?? []).some(
			(entry) =>
				(!entry.guilds || entry.guilds.includes(message.space ?? "")) &&
				(!entry.channels || entry.channels.includes(channelId)),
		);
	}

	/** Whether the channel has answered its rounds of peer bots since a person last posted. */
	exhausted(channel: ChannelKey): boolean {
		return (this.#rounds.get(channel) ?? 0) >= this.#maxRounds;
	}

	/** Counts a peer bot's message the channel answered. */
	answered(channel: ChannelKey): void {
		this.#rounds.set(channel, (this.#rounds.get(channel) ?? 0) + 1);
	}

	/** A person posted in the channel: its rounds start over. */
	personPosted(channel: ChannelKey): void {
		this.#rounds.delete(channel);
	}
}

/**
 * Whether a claim that answers people may answer the author of this message: a person, or a bot
 * the host lists as a peer (`discord.peerBots`) that mentions the bot or replies to it. Use it
 * where a claim once checked `!message.authorIsBot`; the host's allowlist and rounds are already
 * applied by the router, which alone sets `peerBot`. It says nothing of integrations and webhooks.
 */
export function answersAuthor(
	message: Pick<
		InboundMessage,
		"authorIsBot" | "peerBot" | "mentionsBot" | "repliesToBot"
	>,
): boolean {
	if (!message.authorIsBot) return true;
	return (
		message.peerBot === true && (message.mentionsBot || message.repliesToBot)
	);
}
