// Discord voice as plugins use it: joining a guild's voice channel to hear who speaks. It names
// no discord.js type, so a test stands in for it with `fakeDiscordVoice()`.

/** Why a voice channel was not joined. */
export type VoiceJoinFailure =
	| "forbidden" // the bot may not see the channel or connect to it
	| "channel_gone" // the guild has no such channel (any more)
	| "not_voice" // the channel is neither a voice nor a stage channel
	| "full" // the channel is at its user limit, and the bot may not move members
	| "unavailable" // Discord is not connected, the host is stopping, or the voice connection did not come up in time; asking again may work
	| "already_joined"; // the bot has a session in this guild, or is joining one: Discord allows one per guild

/** Why a session ended. */
export type VoiceDisconnectReason =
	| "left" // the plugin called `leave()`
	| "removed" // the bot was disconnected from the channel: someone disconnected it, or the channel was deleted
	| "moved" // someone moved the bot to another channel; a session never follows
	| "connection_lost" // the voice connection dropped and did not come back within the resume time
	| "stopped"; // the host is stopping

/** Someone in a voice channel. */
export interface VoiceMember {
	/** Their Discord user id. */
	userId: string;
	bot: boolean;
	/** What the guild shows for them: the server nickname, else the account's display name. */
	displayName: string;
}

/** Someone entered or left the session's channel. */
export interface VoiceMemberEvent {
	kind: "joined" | "left";
	member: VoiceMember;
}

/** Someone started or stopped speaking, as the session's utterances are cut. */
export interface VoiceSpeakingEvent {
	/** The speaker's Discord user id. */
	userId: string;
	speaking: boolean;
	/** When, by the host's clock, in milliseconds since the epoch. */
	at: number;
}

/** The format of every utterance's `pcm`. */
export const VOICE_PCM = Object.freeze({
	sampleRate: 48_000,
	/** Discord sends stereo; the two channels are mixed down to one. */
	channels: 1,
	/** Signed 16-bit, little-endian. */
	bytesPerSample: 2,
} as const);

/** What one person said from when they started until they went quiet. */
export interface VoiceUtterance {
	/** The speaker's Discord user id. */
	userId: string;
	/**
	 * The decoded audio, in the format `VOICE_PCM` names: 48 kHz, signed 16-bit little-endian,
	 * mono. It holds the audio Discord sent and nothing for the pauses inside it, so its length
	 * may be shorter than `endedAt - startedAt`. The session keeps no copy.
	 */
	pcm: Uint8Array;
	/** When its first audio arrived, by the host's clock, in milliseconds since the epoch. */
	startedAt: number;
	/** When its last audio arrived. */
	endedAt: number;
	/**
	 * True when it holds `maxUtteranceMs` of audio and the speaker went on: the rest is their next
	 * utterance, which always follows, so a run of `continues` utterances ends with one that says
	 * false. One that is full just as its speaker stops says false.
	 */
	continues: boolean;
}

/** How a session cuts what it hears into utterances. */
export interface VoiceJoinOptions {
	/** How long a speaker is quiet before their utterance ends, in milliseconds: 200 to 5,000. Default 800. */
	silenceMs?: number;
	/** The most audio one utterance holds, in milliseconds: 1,000 to 300,000. Default 30,000, about 2.9 MB. */
	maxUtteranceMs?: number;
}

/** The session ended; it reports nothing after this. */
export interface VoiceDisconnectEvent {
	reason: VoiceDisconnectReason;
}

/** What `join` answers: the session, or why there is none. */
export type VoiceJoinResult =
	| { ok: true; session: VoiceSession }
	| {
			ok: false;
			failure: VoiceJoinFailure;
			/** The failure in words, for a log or the person who asked; never audio. */
			message: string;
	  };

/**
 * The bot in one voice channel, muted and listening. Every `on…` returns a function that removes
 * the listener; a listener that throws is logged and never stops the next.
 */
export interface VoiceSession {
	readonly guildId: string;
	readonly channelId: string;
	/** Who is in the channel now, without the bot itself; empty once the session ended. */
	members(): VoiceMember[];
	/** Someone entered or left the channel. */
	onMember(listener: (event: VoiceMemberEvent) => void): () => void;
	/**
	 * Someone started or stopped speaking: `speaking: true` with the first audio of an utterance,
	 * `speaking: false` once they were quiet for `silenceMs`, just before the utterance is delivered.
	 */
	onSpeaking(listener: (event: VoiceSpeakingEvent) => void): () => void;
	/**
	 * A finished utterance of one speaker. One arrives when the speaker went quiet, when their
	 * utterance is full at `maxUtteranceMs` and they go on (`continues: true`), when they left the
	 * channel, and when the session ends, so no audio heard is dropped.
	 */
	onUtterance(listener: (utterance: VoiceUtterance) => void): () => void;
	/** The session ended, once; a listener added after the end is called at once. */
	onDisconnect(listener: (event: VoiceDisconnectEvent) => void): () => void;
	/** Why the session ended; undefined while it is open. */
	ended(): VoiceDisconnectReason | undefined;
	/** Leaves the channel and ends the session with `left`; does nothing once it ended. */
	leave(): Promise<void>;
}

/**
 * Discord voice for plugins: `DISCORD.voice`, there only when the host's `discord.voice` is on.
 * The bot joins muted and not deafened, hears each speaker apart, and never speaks.
 */
export interface DiscordVoice {
	/**
	 * Joins a voice or stage channel of a guild. Never rejects for something Discord refuses: the
	 * answer names the failure. Throws a RangeError for an option out of its range.
	 */
	join(
		target: { guildId: string; channelId: string },
		options?: VoiceJoinOptions,
	): Promise<VoiceJoinResult>;
	/** The open session in a guild, if there is one. */
	session(guildId: string): VoiceSession | undefined;
}
