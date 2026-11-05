import { ConfigError } from "../domain/errors.ts";
import {
	bool,
	either,
	type Field,
	integer,
	list,
	optional,
	shape,
	text,
} from "./schema.ts";

/** One peer bot the host answers, and where. */
export interface PeerBotEntry {
	/** The bot's user id on the surface, a Discord snowflake. */
	id: string;
	/** Answer it only in these servers; left out, in every server of the host. */
	guilds?: readonly string[];
	/** Answer it only in these channels; left out, in every channel. */
	channels?: readonly string[];
	/**
	 * Leave to this bot a person's message that addresses both: when a person mentions or replies to
	 * the host and in the same message mentions this bot or replies to it, the host starts no turn
	 * (observers still hear the message), so only this bot answers and it can hand over by mentioning
	 * the host. Where `guilds` and `channels` do not list the bot, the host does not yield to it.
	 * Set it on one side only: two hosts that yield to each other both stay silent.
	 */
	yields?: boolean;
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
	yields: optional(bool),
});

/** `discord.peerBots`, or the `peerBots` of the host's options. */
export const peerBotsShape = shape({
	allow: list(either(snowflake, entryShape)),
	maxRounds: optional(integer(1, 100)),
});
