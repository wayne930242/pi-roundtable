import type { Logger } from "../../kernel/log.ts";
import type {
	DiscordVoice,
	VoiceDisconnectReason,
	VoiceJoinFailure,
	VoiceJoinOptions,
	VoiceJoinResult,
	VoiceMember,
} from "./voice.ts";
import { systemClock, type VoiceClock } from "./voice-clock.ts";
import { VoiceSessionState } from "./voice-session.ts";

/** A channel as the bot sees it, read when a join is asked. */
export interface VoiceChannelFacts {
	guildId: string;
	kind: "voice" | "stage" | "other";
	/** Whether the bot may see the channel and connect to it. */
	connectable: boolean;
	/** Whether the channel is at its user limit and the bot may not move members. */
	full: boolean;
	/** Who is in it now, without the bot. */
	members: VoiceMember[];
}

/** Someone's voice channel changed: `channelId` is where they are now, undefined for nowhere. */
export interface VoiceStateChange {
	guildId: string;
	userId: string;
	channelId: string | undefined;
	member: VoiceMember;
}

/** `ready` hears audio; `reconnecting` is trying to; `closed` never will again. */
export type VoiceLinkStatus = "ready" | "reconnecting" | "closed";

/** What a voice connection reports to the session that owns it. */
export interface VoiceLinkHandlers {
	status(status: VoiceLinkStatus): void;
	/** One decoded frame of a speaker, in the `VOICE_PCM` format, which the link keeps no reference to. */
	frame(userId: string, pcm: Uint8Array): void;
}

/** One voice connection: the bot in a channel, muted and not deafened. */
export interface VoiceLink {
	status(): VoiceLinkStatus;
	/** Takes the one listener of the link; what happened before it is read from `status()`. */
	listen(handlers: VoiceLinkHandlers): void;
	/** Someone left the channel: what the link kept to hear them is freed, and made again if they are heard after all. */
	forget(userId: string): void;
	/** Leaves the channel and frees the decoders; does nothing the second time. */
	close(): void;
}

/** What the voice service needs of Discord: discord.js and @discordjs/voice in a host, a stand-in in a test. */
export interface VoiceGateway {
	/** Whether the gateway connection is up. */
	ready(): boolean;
	/** The bot's own user id; undefined until the connection is ready. */
	botId(): string | undefined;
	/** The channel as it is now; `gone` for one Discord does not know, `forbidden` for one the bot may not see. Throws when Discord cannot be reached. */
	channel(channelId: string): Promise<VoiceChannelFacts | "gone" | "forbidden">;
	/** Reports every voice channel change in every guild. */
	onVoiceState(listener: (change: VoiceStateChange) => void): void;
	/** Loads what a connection needs, so a host that cannot hear fails as it starts. */
	prepare(): Promise<void>;
	/** Opens the voice connection; rejects when it cannot be opened at all. */
	connect(target: { guildId: string; channelId: string }): Promise<VoiceLink>;
}

export interface VoiceServiceOptions {
	gateway: VoiceGateway;
	logger: Logger;
	clock?: VoiceClock;
	/** How long a new connection may take to become ready. Default 20 s. */
	connectMs?: number;
	/** How long a dropped connection may take to come back before the session ends; at most 30 s. Default 20 s. */
	resumeMs?: number;
}

/** The voice service as the Discord plugin holds it: what plugins get, and its place in the host's start and stop. */
export interface VoiceService extends DiscordVoice {
	start(): Promise<void>;
	/** Ends every session with `stopped` and refuses joins from then on. */
	stop(): Promise<void>;
}

const DEFAULTS = { silenceMs: 800, maxUtteranceMs: 30_000 };
const MAX_RESUME_MS = 30_000;

function inRange(name: string, value: number, min: number, max: number) {
	if (!Number.isInteger(value) || value < min || value > max)
		throw new RangeError(
			`voice join: ${name} must be a whole number from ${min} to ${max}, got ${value}.`,
		);
	return value;
}

const MESSAGES: Record<VoiceJoinFailure, string> = {
	forbidden:
		"The bot may not connect to the channel. Give it View Channel and Connect there.",
	channel_gone: "The guild has no such channel.",
	not_voice: "The channel is neither a voice nor a stage channel.",
	full: "The channel is full.",
	unavailable: "Discord voice is not available right now. Try again.",
	already_joined:
		"The bot is already in a voice channel of this guild, or joining one. Leave it first.",
};

function failed(failure: VoiceJoinFailure, message?: string): VoiceJoinResult {
	return { ok: false, failure, message: message ?? MESSAGES[failure] };
}

interface Joined {
	session: VoiceSessionState;
	link: VoiceLink | undefined;
	/** Whether `join` answered with the session: until then nothing ends it but the join itself. */
	open: boolean;
	/** Runs when the connection stayed down too long. */
	resume: unknown;
}

/**
 * Voice sessions over a gateway, one per guild. A join checks the channel before it connects, so
 * each refusal has its own failure; a connection that drops has `resumeMs` to come back.
 */
export function voiceService(options: VoiceServiceOptions): VoiceService {
	const { gateway, logger } = options;
	const clock = options.clock ?? systemClock;
	const connectMs = options.connectMs ?? 20_000;
	const resumeMs = Math.min(options.resumeMs ?? 20_000, MAX_RESUME_MS);
	/** By guild: Discord has one voice connection per guild. */
	const joined = new Map<string, Joined>();
	let stopping = false;

	const end = (entry: Joined, reason: VoiceDisconnectReason): void => {
		const { session } = entry;
		if (joined.get(session.guildId) === entry) joined.delete(session.guildId);
		clock.clearTimeout(entry.resume);
		entry.resume = undefined;
		session.end(reason);
		entry.link?.close();
		logger.info(
			{ guildId: session.guildId, channelId: session.channelId, reason },
			"voice session ended",
		);
	};

	const onStatus = (entry: Joined, status: VoiceLinkStatus): void => {
		if (!entry.open || entry.session.ended() !== undefined) return;
		if (status === "closed") {
			end(entry, "connection_lost");
		} else if (status === "ready") {
			if (entry.resume === undefined) return;
			clock.clearTimeout(entry.resume);
			entry.resume = undefined;
			void reread(entry);
		} else {
			entry.resume ??= clock.setTimeout(
				() => end(entry, "connection_lost"),
				resumeMs,
			);
		}
	};

	/** Someone is no longer in the session's channel: what they were saying is delivered, then the link lets go of them. */
	const gone = (entry: Joined, userId: string): void => {
		entry.session.memberLeft(userId);
		entry.link?.forget(userId);
	};

	/**
	 * A dropped connection is back: who is in the channel is read again, and whoever left or
	 * entered meanwhile is reported now. A gateway that had to identify again is sent the guild's
	 * voice states anew, with no word of what changed.
	 */
	const reread = async (entry: Joined): Promise<void> => {
		const { session } = entry;
		try {
			const facts = await gateway.channel(session.channelId);
			if (session.ended() !== undefined || typeof facts === "string") return;
			const there = new Set(facts.members.map((member) => member.userId));
			for (const { userId } of session.members())
				if (!there.has(userId)) gone(entry, userId);
			for (const member of facts.members) session.memberJoined(member);
		} catch (error) {
			logger.warn(
				{ guildId: session.guildId, channelId: session.channelId, err: error },
				"voice members not read again",
			);
		}
	};

	gateway.onVoiceState((change) => {
		const entry = joined.get(change.guildId);
		if (!entry) return;
		const { session } = entry;
		if (change.userId === gateway.botId()) {
			// Its own way into the channel is the join's to wait for.
			if (!entry.open || change.channelId === session.channelId) return;
			return end(entry, change.channelId === undefined ? "removed" : "moved");
		}
		if (change.channelId === session.channelId)
			session.memberJoined(change.member);
		else gone(entry, change.userId);
	});

	/** Resolves true once the link is ready; false when it closed or took longer than `connectMs`. */
	const comesUp = (entry: Joined, link: VoiceLink): Promise<boolean> =>
		new Promise((resolve) => {
			const timer = clock.setTimeout(() => resolve(false), connectMs);
			const settle = (status: VoiceLinkStatus) => {
				if (status === "reconnecting") return;
				clock.clearTimeout(timer);
				resolve(status === "ready");
			};
			link.listen({
				status: (status) => {
					settle(status);
					onStatus(entry, status);
				},
				frame: (userId, pcm) => entry.session.frame(userId, pcm),
			});
			settle(link.status());
		});

	const join = async (
		target: { guildId: string; channelId: string },
		given: VoiceJoinOptions = {},
	): Promise<VoiceJoinResult> => {
		const silenceMs = inRange(
			"silenceMs",
			given.silenceMs ?? DEFAULTS.silenceMs,
			200,
			5_000,
		);
		const maxUtteranceMs = inRange(
			"maxUtteranceMs",
			given.maxUtteranceMs ?? DEFAULTS.maxUtteranceMs,
			1_000,
			300_000,
		);
		const { guildId, channelId } = target;
		if (stopping || !gateway.ready()) return failed("unavailable");
		if (joined.has(guildId)) return failed("already_joined");
		// Held from here on, so a second join of the guild is refused while this one is under way.
		const entry: Joined = {
			session: new VoiceSessionState({
				guildId,
				channelId,
				members: [],
				silenceMs,
				maxUtteranceMs,
				clock,
				logger,
				leave: () => end(entry, "left"),
			}),
			link: undefined,
			open: false,
			resume: undefined,
		};
		joined.set(guildId, entry);
		const refuse = (failure: VoiceJoinFailure, error?: unknown) => {
			if (joined.get(guildId) === entry) joined.delete(guildId);
			entry.link?.close();
			if (error !== undefined)
				logger.warn({ guildId, channelId, err: error }, "voice join failed");
			return failed(failure);
		};
		try {
			const facts = await gateway.channel(channelId);
			if (facts === "gone") return refuse("channel_gone");
			if (facts === "forbidden") return refuse("forbidden");
			if (facts.kind === "other") return refuse("not_voice");
			if (facts.guildId !== guildId) return refuse("channel_gone");
			if (!facts.connectable) return refuse("forbidden");
			if (facts.full) return refuse("full");
			// Whoever enters or leaves while the connection comes up is heard through the gateway from here.
			for (const member of facts.members) entry.session.memberJoined(member);
			if (stopping) return refuse("unavailable");
			const link = await gateway.connect(target);
			entry.link = link;
			const up = await comesUp(entry, link);
			if (stopping || !up || link.status() === "closed")
				return refuse("unavailable");
			entry.open = true;
			// A drop between coming up and here starts the resume time like any later one.
			if (link.status() === "reconnecting") onStatus(entry, "reconnecting");
		} catch (error) {
			return refuse("unavailable", error);
		}
		logger.info({ guildId, channelId }, "voice session joined");
		return { ok: true, session: entry.session };
	};

	return {
		join,
		session: (guildId) => {
			const entry = joined.get(guildId);
			return entry?.open ? entry.session : undefined;
		},
		start: () => gateway.prepare(),
		stop: async () => {
			stopping = true;
			for (const entry of [...joined.values()])
				if (entry.open) end(entry, "stopped");
		},
	};
}
