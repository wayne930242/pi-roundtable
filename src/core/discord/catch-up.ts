import type { InboundMessage } from "../contract/channels.ts";
import { ConfigError } from "../domain/errors.ts";
import type { Logger } from "../kernel/log.ts";
import type { InboundJournal } from "./catch-up-journal.ts";

/** What `discord.catchUp` takes. */
export interface CatchUpOptions {
	/** How far back, in minutes before the connection is ready, a missed message is still answered: 1 to 1440. Default 10. */
	windowMinutes?: number;
	/** The most missed messages answered after one restart, the newest; 1 to 100. Default 20. */
	maxMessages?: number;
}

/** `CatchUpOptions` with the defaults filled in. */
export type CatchUpSettings = Required<CatchUpOptions>;

const DEFAULT_WINDOW_MINUTES = 10;
const DEFAULT_MAX_MESSAGES = 20;
/** How long a record is kept: a direct-message channel is remembered this long, to be looked into after a restart. */
export const JOURNAL_DAYS = 30;
/** The most remembered direct-message channels fetched to see whether they had a message lately. */
const DIRECT_PROBES = 25;
/** The most channels whose messages one catch-up reads, one request each. */
const MAX_CHANNEL_READS = 50;
/** The messages read before the ready time in each channel, one page. */
const PAGE = 100;
export const DAY_MS = 86_400_000;
const DISCORD_EPOCH = 1_420_070_400_000n;

const whole = (value: number | undefined, low: number, high: number) =>
	value === undefined ||
	(Number.isInteger(value) && value >= low && value <= high);

/** The settings of `discord.catchUp`; throws a `ConfigError` for a value out of range. */
export function catchUpSettings(options: CatchUpOptions): CatchUpSettings {
	if (!whole(options.windowMinutes, 1, 1440))
		throw new ConfigError(
			"discord.catchUp.windowMinutes must be a whole number from 1 to 1440",
		);
	if (!whole(options.maxMessages, 1, 100))
		throw new ConfigError(
			"discord.catchUp.maxMessages must be a whole number from 1 to 100",
		);
	return {
		windowMinutes: options.windowMinutes ?? DEFAULT_WINDOW_MINUTES,
		maxMessages: options.maxMessages ?? DEFAULT_MAX_MESSAGES,
	};
}

/** The first snowflake Discord could assign at `ms`, as a bound for reading messages before it. */
export const snowflakeAt = (ms: number): string =>
	((BigInt(ms) - DISCORD_EPOCH) << 22n).toString();

/** When Discord assigned a snowflake, in epoch milliseconds. */
export const timeOf = (id: string): number =>
	Number((BigInt(id) >> 22n) + DISCORD_EPOCH);

/** A person's message to the bot: a direct message, a mention, or a reply to it; never a bot's or a webhook's. */
export function addressed(message: InboundMessage): boolean {
	return (
		!message.authorIsBot &&
		!message.integration &&
		(message.isDirect || message.mentionsBot || message.repliesToBot)
	);
}

/** The parts of a Discord message catch-up reads before it reads the message in full; a discord.js `Message` has them. */
export interface ScannedMessage {
	id: string;
	createdTimestamp: number;
	author: { id: string; bot: boolean };
	webhookId: string | null;
	applicationId: string | null;
	system: boolean;
	mentions: {
		users: { has(id: string): boolean };
		repliedUser: { id: string } | null;
	};
	/** Whether a thread was started from it, as the bot answers a mention in a thread. */
	hasThread?: boolean;
	/** Its reactions; one the bot added counts as an answer. */
	reactions?: {
		cache: { some(test: (reaction: { me: boolean }) => boolean): boolean };
	};
}

/** A channel catch-up may read. */
export interface CatchUpChannel<M extends ScannedMessage> {
	id: string;
	direct: boolean;
	/** When its last message was posted, as the client knows it; undefined for none. */
	lastMessageAt: number | undefined;
	/** Up to `limit` of its messages before the snowflake `before`, in any order. */
	read(before: string, limit: number): Promise<M[]>;
}

/** Discord as catch-up reads it, once the connection is ready. */
export interface CatchUpReader<M extends ScannedMessage> {
	botId: string;
	applicationId: string | undefined;
	/** When the connection became ready: from then on the gateway delivers each message. */
	readyAt: number;
	/** The server channels, threads and forum posts the bot can read, and the direct messages the client holds, without a request. */
	channels(): CatchUpChannel<M>[];
	/** A direct-message channel by its id; undefined when it is not one. */
	direct(channelId: string): Promise<CatchUpChannel<M> | undefined>;
	/** The message as the live gateway would deliver it. */
	inbound(message: M): Promise<InboundMessage | undefined>;
}

export interface CatchUpDeps<M extends ScannedMessage> {
	reader: CatchUpReader<M>;
	journal: InboundJournal;
	/** Hands a message to routing, as the live gateway does. */
	deliver(message: InboundMessage): void;
	settings: CatchUpSettings;
	logger: Logger;
	/** True once the host shuts down: nothing more is delivered. */
	stopping?: () => boolean;
	/** Hears, before any is read, the channels catch-up may read, a few more than it does: those its cache shows active, and the remembered direct messages. */
	planned?: (channelIds: string[]) => void;
	/** Whether the live gateway delivered the message without recording it, in this process: it is not delivered again. */
	passedLive?: (messageId: string) => boolean;
	now?: () => number;
}

/** What one catch-up did, in counts; logged, never the messages. */
export interface CatchUpReport {
	channels: number;
	unread: number;
	missed: number;
	replied: number;
	overCap: number;
	handled: number;
	failed: number;
	delivered: number;
}

/**
 * The channels to read: those the client knows of, and the remembered direct messages, whose last
 * message falls in the window, the most recently active first, at most `MAX_CHANNEL_READS`.
 */
async function channelsToRead<M extends ScannedMessage>(
	deps: CatchUpDeps<M>,
	since: number,
	now: number,
): Promise<CatchUpChannel<M>[]> {
	const { reader, journal, logger } = deps;
	const known = reader.channels();
	const ids = new Set(known.map((channel) => channel.id));
	const directs = await journal
		.directChannels(
			reader.botId,
			new Date(now - JOURNAL_DAYS * DAY_MS),
			DIRECT_PROBES,
		)
		.catch((error: unknown) => {
			logger.warn({ err: error }, "catch-up could not list direct messages");
			return [];
		});
	// Live messages wait for this, not for the direct messages to be fetched.
	deps.planned?.([
		...known
			.filter((channel) => (channel.lastMessageAt ?? 0) >= since)
			.map((channel) => channel.id),
		...directs,
	]);
	for (const id of directs) {
		if (ids.has(id)) continue;
		const channel = await reader.direct(id).catch(() => undefined);
		if (channel) known.push(channel);
	}
	return known
		.filter((channel) => (channel.lastMessageAt ?? 0) >= since)
		.toSorted((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0))
		.slice(0, MAX_CHANNEL_READS);
}

/** Which of the bot's posts are restart notices, recorded as it shut down; undefined when that cannot be read. */
async function restartNotices<M extends ScannedMessage>(
	{ journal, reader, logger }: CatchUpDeps<M>,
	posts: M[],
): Promise<Set<string> | undefined> {
	return journal
		.recordedAmong(
			reader.botId,
			posts.map((post) => post.id),
		)
		.catch((error: unknown) => {
			logger.warn({ err: error }, "catch-up could not look up restart notices");
			return undefined;
		});
}

/**
 * Answers the messages addressed to the bot that came while the host was down: after the
 * connection is ready, reads the channels active in the window and hands routing each person's
 * mention, reply to the bot, or direct message from the window that the bot did not answer and
 * that no one recorded, oldest first, marked `caughtUp`. A message is recorded in the journal
 * before it is handed on, so a second restart, or a crash during its turn, never answers it again.
 * Never rejects; reports its counts.
 */
export async function catchUp<M extends ScannedMessage>(
	deps: CatchUpDeps<M>,
): Promise<CatchUpReport> {
	const { reader, journal, settings, logger } = deps;
	const now = deps.now?.() ?? Date.now();
	const { readyAt, botId } = reader;
	const since = readyAt - settings.windowMinutes * 60_000;
	const report: CatchUpReport = {
		channels: 0,
		unread: 0,
		missed: 0,
		replied: 0,
		overCap: 0,
		handled: 0,
		failed: 0,
		delivered: 0,
	};
	const own = reader.applicationId ?? botId;
	const byBot = (message: M) =>
		message.author.id === botId ||
		(message.webhookId !== null && message.applicationId === own);
	const missed: { message: M; channel: CatchUpChannel<M> }[] = [];
	const reading = await channelsToRead(deps, since, now).catch(
		(error: unknown) => {
			logger.warn({ err: error }, "catch-up could not list its channels");
			return [];
		},
	);
	for (const channel of reading) {
		if (deps.stopping?.()) return report;
		report.channels += 1;
		let messages: M[];
		try {
			messages = await channel.read(snowflakeAt(readyAt), PAGE);
		} catch (error) {
			report.unread += 1;
			logger.warn(
				{ channelId: channel.id, err: error },
				"catch-up could not read a channel",
			);
			continue;
		}
		const notices = await restartNotices(deps, messages.filter(byBot));
		// Not knowing which posts are notices, it could take one for an answer: the channel is left for a later restart.
		if (!notices) {
			report.unread += 1;
			continue;
		}
		const answeredUpTo = messages
			.filter((message) => byBot(message) && !notices.has(message.id))
			.reduce((latest, message) => {
				const id = BigInt(message.id);
				return id > latest ? id : latest;
			}, 0n);
		for (const message of messages) {
			const { author, mentions } = message;
			if (
				message.createdTimestamp < since ||
				message.createdTimestamp >= readyAt ||
				author.bot ||
				message.webhookId !== null ||
				message.system ||
				!(
					channel.direct ||
					mentions.users.has(botId) ||
					mentions.repliedUser?.id === botId
				)
			)
				continue;
			// The bot posted after it, so it was answered then; a notice that it restarts is no answer.
			// A thread started from it or a reaction of the bot's is an answer the channel does not show.
			if (
				BigInt(message.id) < answeredUpTo ||
				message.hasThread ||
				message.reactions?.cache.some((reaction) => reaction.me)
			)
				report.replied += 1;
			else missed.push({ message, channel });
		}
	}
	missed.sort((a, b) => (BigInt(a.message.id) < BigInt(b.message.id) ? -1 : 1));
	report.missed = missed.length;
	report.overCap = Math.max(0, missed.length - settings.maxMessages);
	for (const { message, channel } of missed.slice(report.overCap)) {
		if (deps.stopping?.()) break;
		if (deps.passedLive?.(message.id)) {
			report.handled += 1;
			continue;
		}
		try {
			const inbound = await reader.inbound(message);
			if (!inbound) continue;
			const first = await journal.claim({
				botId,
				messageId: message.id,
				channelId: channel.id,
				direct: channel.direct,
			});
			if (!first) {
				report.handled += 1;
				continue;
			}
			// Routing refuses it once the host shuts down; the next process takes it in instead.
			if (deps.stopping?.()) {
				await journal
					.release(botId, message.id)
					.catch((error: unknown) =>
						logger.warn(
							{ channelId: channel.id, messageId: message.id, err: error },
							"catch-up could not release a message as the host stops; no process answers it",
						),
					);
				break;
			}
			deps.deliver({ ...inbound, caughtUp: true });
			report.delivered += 1;
		} catch (error) {
			// Unrecorded, it is not answered: a second answer is worse than none.
			report.failed += 1;
			logger.warn(
				{ channelId: channel.id, messageId: message.id, err: error },
				"catch-up skipped a missed message it could not read or record",
			);
		}
	}
	await journal
		.prune(new Date(now - JOURNAL_DAYS * DAY_MS))
		.catch((error: unknown) =>
			logger.warn({ err: error }, "catch-up could not prune its journal"),
		);
	logger.info({ ...report }, "discord catch-up done");
	return report;
}
