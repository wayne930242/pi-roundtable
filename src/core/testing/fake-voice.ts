import type {
	DiscordVoice,
	VoiceDisconnectReason,
	VoiceMember,
} from "../discord/voice/voice.ts";
import { manualVoiceClock } from "../discord/voice/voice-clock.ts";
import {
	type VoiceLinkHandlers,
	type VoiceLinkStatus,
	type VoiceStateChange,
	voiceService,
} from "../discord/voice/voice-service.ts";
import { silentLogger } from "../kernel/log.ts";

/** A channel of the fake's Discord. */
export interface FakeVoiceChannel {
	guildId: string;
	/** Default `voice`; `text` stands for every channel that is not joined by voice. */
	kind?: "voice" | "stage" | "text";
	/** Who is in it; `enter` and `exit` change it. Default nobody. */
	members?: VoiceMember[];
	/** The bot may not see it or connect to it. */
	forbidden?: boolean;
	/** It is at its user limit. */
	full?: boolean;
}

/** What a test reads and drives on the fake voice, besides the `DiscordVoice` calls. */
export interface FakeDiscordVoice extends DiscordVoice {
	/** The channels that exist, by id; a join of any other answers `channel_gone`. */
	readonly channels: Map<string, FakeVoiceChannel>;
	/** Whether Discord is connected; `false` makes a join answer `unavailable`. */
	available: boolean;
	/** Every join asked for, in order, whatever it answered. */
	readonly joins: { guildId: string; channelId: string }[];
	/** Every session that ended, in order, with why: `left` for the plugin's own `leave()`. */
	readonly ended: {
		guildId: string;
		channelId: string;
		reason: VoiceDisconnectReason;
	}[];
	/** The bot's user id, which is never among a session's members. */
	readonly botId: string;
	/** Someone enters a channel, leaving the one they were in. */
	enter(channelId: string, member: VoiceMember): void;
	/** Someone leaves a channel. */
	exit(channelId: string, userId: string): void;
	/**
	 * One frame of someone speaking in a channel, as 48 kHz 16-bit mono PCM; they must be in it.
	 * A session in that channel hears it, and its clock moves on by the frame's length. Their
	 * utterance stays open until `quiet()`.
	 */
	audio(channelId: string, userId: string, pcm: Uint8Array): void;
	/** Everyone stops speaking: five seconds pass, so every open utterance ends. */
	quiet(): void;
	/** `audio` for each frame, then `quiet()`: one whole utterance. */
	say(channelId: string, userId: string, ...frames: Uint8Array[]): void;
	/** Ends the guild's session from outside: the bot is disconnected, moved elsewhere, or loses its connection for good. */
	drop(guildId: string, how: "removed" | "moved" | "connection_lost"): void;
	/** The host stops: every session ends with `stopped`, and joins answer `unavailable`. */
	stop(): Promise<void>;
}

const BOT: VoiceMember = {
	userId: "900000000000000001",
	bot: true,
	displayName: "bot",
};
/** Bytes of a millisecond of 48 kHz 16-bit mono. */
const BYTES_PER_MS = 96;
/** Longer than any `silenceMs` a join may ask for. */
const QUIET_MS = 5_000;

/**
 * `DISCORD.voice` in memory, for a plugin's tests: the real session logic (members, utterances,
 * one session per guild, the join failures) over a Discord the test drives. Give it to
 * `fakeDiscord({ voice })` or `testHost({ discord: { voice } })`. `now` is where its clock starts.
 */
export function fakeDiscordVoice(
	options: { now?: number } = {},
): FakeDiscordVoice {
	const clock = manualVoiceClock(options.now);
	const channels = new Map<string, FakeVoiceChannel>();
	const joins: FakeDiscordVoice["joins"] = [];
	const ended: FakeDiscordVoice["ended"] = [];
	/** The open connection of each guild: where the bot is, and who listens. */
	const links = new Map<
		string,
		{ channelId: string; handlers: VoiceLinkHandlers | undefined }
	>();
	let report: (change: VoiceStateChange) => void = () => undefined;
	let available = true;

	const channelOf = (channelId: string, call: string): FakeVoiceChannel => {
		const channel = channels.get(channelId);
		if (!channel)
			throw new Error(
				`fakeDiscordVoice ${call}: there is no channel ${channelId}. Add it first: voice.channels.set("${channelId}", { guildId: "..." }).`,
			);
		return channel;
	};
	const without = (channel: FakeVoiceChannel, userId: string) =>
		(channel.members ?? []).filter((member) => member.userId !== userId);

	const service = voiceService({
		clock,
		logger: silentLogger(),
		gateway: {
			ready: () => available,
			botId: () => BOT.userId,
			channel: async (channelId) => {
				const channel = channels.get(channelId);
				if (!channel) return "gone";
				return {
					guildId: channel.guildId,
					kind: channel.kind === "text" ? "other" : (channel.kind ?? "voice"),
					connectable: !channel.forbidden,
					full: channel.full ?? false,
					members: without(channel, BOT.userId),
				};
			},
			onVoiceState: (listener) => {
				report = listener;
			},
			prepare: async () => undefined,
			connect: async ({ guildId, channelId }) => {
				let status: VoiceLinkStatus = "ready";
				const link = {
					channelId,
					handlers: undefined as VoiceLinkHandlers | undefined,
				};
				links.set(guildId, link);
				return {
					status: () => status,
					listen: (handlers) => {
						link.handlers = handlers;
					},
					forget: () => undefined,
					close: () => {
						status = "closed";
						if (links.get(guildId) === link) links.delete(guildId);
					},
				};
			},
		},
	});

	const fake: FakeDiscordVoice = {
		channels,
		get available() {
			return available;
		},
		set available(value: boolean) {
			available = value;
		},
		joins,
		ended,
		botId: BOT.userId,
		join: async (target, given) => {
			joins.push({ guildId: target.guildId, channelId: target.channelId });
			const answer = await service.join(target, given);
			if (answer.ok)
				answer.session.onDisconnect(({ reason }) =>
					ended.push({ ...target, reason }),
				);
			return answer;
		},
		session: (guildId) => service.session(guildId),
		enter(channelId, member) {
			const channel = channelOf(channelId, "enter");
			for (const [id, other] of channels)
				if (id !== channelId && other.guildId === channel.guildId)
					other.members = without(other, member.userId);
			channel.members = [...without(channel, member.userId), member];
			report({
				guildId: channel.guildId,
				userId: member.userId,
				channelId,
				member,
			});
		},
		exit(channelId, userId) {
			const channel = channelOf(channelId, "exit");
			const member = channel.members?.find((one) => one.userId === userId);
			if (!member) return;
			channel.members = without(channel, userId);
			report({
				guildId: channel.guildId,
				userId,
				channelId: undefined,
				member,
			});
		},
		audio(channelId, userId, pcm) {
			const channel = channelOf(channelId, "audio");
			if (!channel.members?.some((member) => member.userId === userId))
				throw new Error(
					`fakeDiscordVoice audio: ${userId} is not in the channel ${channelId}. Call enter("${channelId}", { userId: "${userId}", ... }) first.`,
				);
			const link = links.get(channel.guildId);
			// Copied, as a decoder hands the session a frame of its own.
			if (link?.channelId === channelId)
				link.handlers?.frame(userId, pcm.slice());
			clock.advance(pcm.byteLength / BYTES_PER_MS);
		},
		quiet() {
			clock.advance(QUIET_MS);
		},
		say(channelId, userId, ...frames) {
			for (const frame of frames) fake.audio(channelId, userId, frame);
			fake.quiet();
		},
		drop(guildId, how) {
			const link = links.get(guildId);
			if (!link) return;
			if (how === "connection_lost") return link.handlers?.status("closed");
			report({
				guildId,
				userId: BOT.userId,
				channelId: how === "moved" ? `${link.channelId}-elsewhere` : undefined,
				member: BOT,
			});
		},
		stop: () => service.stop(),
	};
	return fake;
}
