import {
	DEFAULT_PEER_ROUNDS,
	type PeerBotEntry,
	type PeerBotsConfig,
	peerBotsShape,
} from "../config/peer-bots.ts";
import type { InboundMessage } from "../contract/channels.ts";
import { parseChannelKey } from "../contract/surface.ts";
import type { ChannelKey } from "../sessions.ts";

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
		return this.#listsHere(message.authorId, message) !== undefined;
	}

	/** Whether the host lists this bot for the message's channel and server, whoever wrote the message. */
	listsBot(botId: string, message: InboundMessage): boolean {
		return this.#listsHere(botId, message) !== undefined;
	}

	/**
	 * The peer bot a person's message addressed to the host is left to: one the host lists here with
	 * `yields` that the message also mentions or replies to; undefined when the host answers it.
	 */
	yieldsTo(message: InboundMessage): string | undefined {
		// The peer cannot answer in a direct conversation, so the host never yields one.
		if (message.authorIsBot || message.integration || message.isDirect)
			return undefined;
		if (!message.mentionsBot && !message.repliesToBot) return undefined;
		const addressed = new Set(message.mentionedUserIds ?? []);
		if (message.reference?.authorId) addressed.add(message.reference.authorId);
		for (const id of addressed)
			if (this.#listsHere(id, message)?.yields) return id;
		return undefined;
	}

	/** The bot's entry that covers this message's channel and server, preferring one that yields. */
	#listsHere(botId: string, message: InboundMessage): PeerBotEntry | undefined {
		const { surface, id: channelId } = parseChannelKey(message.channel);
		if (surface !== this.#surface) return undefined;
		const here = (this.#entries.get(botId) ?? []).filter(
			(entry) =>
				(!entry.guilds || entry.guilds.includes(message.space ?? "")) &&
				(!entry.channels || entry.channels.includes(channelId)),
		);
		return here.find((entry) => entry.yields) ?? here[0];
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

/**
 * The message as a listed peer bot's reaches the access rules: without the server roles it holds,
 * which a rule written for people could otherwise use to lift a bot above what its identity and
 * `everyone` give.
 */
export function peerFacts(message: InboundMessage): InboundMessage {
	const { authorRoleIds: _ids, actor, ...rest } = message;
	if (!actor) return rest;
	const { roles: _roles, ...bare } = actor;
	return { ...rest, actor: bare };
}
