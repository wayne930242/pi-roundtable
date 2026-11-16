import type { VoiceConnection, VoiceConnectionState } from "@discordjs/voice";
import type { Logger } from "../../kernel/log.ts";
import type { VoiceClock } from "./voice-clock.ts";

// Whether a voice link hears. A connection's state says nothing of its audio: after the library
// resumed a dropped voice socket, the connection is ready again over the media socket it had,
// and Discord's audio may no longer arrive there. Nothing but a datagram shows that it does, and
// silence shows nothing, so the watch goes by what contradicts silence: the voice socket naming
// someone who speaks, and a resume that cut into a channel that was being heard.

/**
 * How long after the voice socket says someone speaks a datagram must have come. A speaker's
 * audio is a datagram every 20 ms from that moment, so 2 s without one is a hundred missing in
 * a row, which no jitter or loss explains; and 2 s is all a recorder loses before the remedy.
 */
const SPEAKING_PROOF_MS = 2_000;
/**
 * How long after a resume a datagram must have come, in a channel that was heard shortly before.
 * Nothing says anyone speaks then, so the pause between two sentences has to fit in it: 5 s
 * keeps most pauses from being taken for deafness, and bounds what is lost when it is deafness.
 */
const RESUME_PROOF_MS = 5_000;
/**
 * How long before its voice socket dropped a channel counts as heard. Whoever was speaking is
 * cut off when the network goes, and the socket follows later: the library closes it after
 * three missed heartbeats of some 14 s each, checked at the fourth, and a socket that cannot
 * say goodbye takes up to 30 s more to close, 85 s in all. Two minutes span that, and a channel
 * quiet for longer is left alone.
 */
const RECENT_MS = 120_000;
/**
 * How long a media path is up before a speaking state counts as someone speaking. To a
 * connection that just came up or resumed, Discord may repeat the states it sent before; those
 * name speakers and say nothing of now.
 */
const SETTLE_MS = 3_000;
/** How long a remedy has to bring audio before the next one. */
const VERIFY_MS = 10_000;
/** How many datagrams of a speaker the voice socket never named are worth a line: two seconds of audio. */
const UNNAMED_DATAGRAMS = 100;

export interface HearingOptions {
	clock: VoiceClock;
	logger: Logger;
	/** What every line of the watch names; never audio. */
	fields: { guildId: string; channelId: string };
	/** Whether the user is a person in the channel, not a bot; with no user, whether any person is. */
	person(userId?: string): boolean;
	/** Whether a moderator deafened the bot: Discord then sends it no audio, which no remedy mends. */
	deafened(): boolean;
	/** Sets the media path up again without leaving the channel; false when that could not be started. */
	rebuild(): boolean;
	/** Leaves the channel and joins it again. */
	rejoin(): void;
	/** Nothing made the link hear: it is closed. */
	giveUp(): void;
}

/** What a link tells the watch of its connection. */
export interface HearingWatch {
	/** The connection is ready over a media path it did not have before. */
	up(): void;
	/** The connection is ready over the media path it had: its voice socket was resumed. */
	resumed(): void;
	/** The connection is no longer ready. */
	down(): void;
	/** The voice socket says the user is speaking. */
	speaking(userId: string): void;
	/**
	 * An audio datagram arrived; `named` is whether the voice socket said whose it is. Only a named
	 * one is heard: the receiver hands nobody the audio of a speaker it cannot name.
	 */
	audio(named: boolean): void;
	stop(): void;
}

/**
 * Watches whether a link hears, and remedies a link that does not: first the media path is set
 * up again, which nobody in the channel notices; a speaker still not heard 10 s later has the
 * bot leave the channel and join it again; a speaker not heard after that closes the link.
 * A datagram of a speaker the voice socket named ends it all. Silence alone goes no further than the first remedy, and that one
 * only after a resume: a quiet channel is never left, and never closed.
 */
export function hearingWatch(options: HearingOptions): HearingWatch {
	const { clock, logger, fields } = options;
	let ready = false;
	let stopped = false;
	/** When the media path came up or was resumed. */
	let since = 0;
	/** When the media path last carried audio of a speaker the voice socket named. */
	let lastAudioAt: number | undefined;
	/** How long the media path had carried none when the connection last stopped being ready; undefined when it never had. */
	let quietAtDrop: number | undefined;
	/** Whether audio came while the connection was not ready: the media path never stopped. */
	let heardAway = false;
	/** The remedies used since audio was last heard: 1 the media path, 2 the rejoin. */
	let remedies: 0 | 1 | 2 = 0;
	/** Whether someone was said to speak and was not heard, since audio was last heard. */
	let evidenced = false;
	/** Datagrams of speakers the voice socket has not named, since the media path came up or was resumed. */
	let unnamed = 0;
	/** When someone was first said to speak while the first remedy is waited on: its 10 s are not cut short for them. */
	let saidAt: number | undefined;
	/** The one deadline that runs: for a datagram after a speaking state or a resume, or after a remedy. */
	let timer: unknown;
	let waitsFor: "speaking" | "resume" | "remedy" | undefined;

	const disarm = (): void => {
		clock.clearTimeout(timer);
		timer = undefined;
		waitsFor = undefined;
	};
	const arm = (what: NonNullable<typeof waitsFor>, ms: number): void => {
		disarm();
		waitsFor = what;
		timer = clock.setTimeout(() => due(what), ms);
	};

	/** The next remedy, of a link that does not hear. */
	const remedy = (after: "speaking" | "resume"): void => {
		if (remedies === 0) {
			remedies = 1;
			if (options.rebuild()) {
				logger.warn(
					{ ...fields, after },
					"voice hears nothing: its networking is set up again",
				);
				return;
			}
			// Without word of a speaker the channel is not left: the next one who is not heard takes it from here.
			if (!evidenced) {
				logger.warn(
					{ ...fields, after },
					"voice hears nothing, and its networking could not be set up again",
				);
				return;
			}
		}
		if (remedies === 1) {
			remedies = 2;
			logger.warn(
				fields,
				"voice hears nothing: the channel is left and joined again",
			);
			options.rejoin();
			return;
		}
		logger.warn(fields, "voice audio not recovered");
		options.giveUp();
	};

	const due = (what: NonNullable<typeof waitsFor>): void => {
		timer = undefined;
		waitsFor = undefined;
		// A deafened bot was sent nothing to hear: its silence shows no fault.
		if (stopped || !ready || options.deafened()) return;
		if (what === "speaking") {
			evidenced = true;
			remedy("speaking");
		} else if (what === "resume") remedy("resume");
		// A remedy brought no audio in its time: the next one is for a speaker, never for silence.
		else if (remedies === 1 && (evidenced || saidAt !== undefined)) {
			// Someone named while it was waited on has their own 2 s to be heard, like anyone.
			const left =
				evidenced || saidAt === undefined
					? 0
					: SPEAKING_PROOF_MS - (clock.now() - saidAt);
			saidAt = undefined;
			if (left > 0) arm("speaking", left);
			else {
				evidenced = true;
				remedy("speaking");
			}
		} else
			logger.warn(
				{ ...fields, remedies },
				"voice has heard nothing since its remedy",
			);
	};

	return {
		up() {
			ready = true;
			since = clock.now();
			lastAudioAt = undefined;
			unnamed = 0;
			saidAt = undefined;
			if (remedies > 0) arm("remedy", VERIFY_MS);
		},
		resumed() {
			ready = true;
			since = clock.now();
			unnamed = 0;
			if (remedies > 0) {
				arm("remedy", VERIFY_MS);
				return;
			}
			const heard = quietAtDrop !== undefined && quietAtDrop <= RECENT_MS;
			if (heard && !heardAway && options.person())
				arm("resume", RESUME_PROOF_MS);
		},
		down() {
			if (ready) {
				quietAtDrop =
					lastAudioAt === undefined ? undefined : clock.now() - lastAudioAt;
				heardAway = false;
			}
			ready = false;
			saidAt = undefined;
			disarm();
		},
		speaking(userId) {
			if (stopped || !ready || waitsFor === "speaking") return;
			if (clock.now() - since < SETTLE_MS || !options.person(userId)) return;
			if (options.deafened()) return;
			const now = clock.now();
			// The word of a speaker can come after their audio: the voice socket resends what it lost, a
			// datagram is never resent. Whoever was heard this shortly before is no evidence of deafness.
			if (lastAudioAt !== undefined && now - lastAudioAt < SPEAKING_PROOF_MS)
				return;
			// The first remedy keeps its time: the speaker is weighed when it is over.
			if (waitsFor === "remedy" && remedies === 1) {
				saidAt ??= now;
				return;
			}
			arm("speaking", SPEAKING_PROOF_MS);
		},
		audio(named) {
			// Audio nobody is handed is not hearing: it ends no deadline and no remedy.
			if (!named) {
				if (++unnamed === UNNAMED_DATAGRAMS)
					logger.warn(
						{ ...fields, datagrams: unnamed },
						"voice audio arrives from a speaker the voice socket has not named",
					);
				return;
			}
			lastAudioAt = clock.now();
			if (!ready) heardAway = true;
			saidAt = undefined;
			if (timer !== undefined) disarm();
			if (remedies === 0) return;
			logger.info({ ...fields, remedies }, "voice hears again");
			remedies = 0;
			evidenced = false;
		},
		stop() {
			stopped = true;
			disarm();
		},
	};
}

/** The voice opcode of someone's speaking state. */
const SPEAKING = 5;
/** The flag of a speaking state that says the microphone is sending; the others are for sound shared with a video and for priority. */
const MICROPHONE = 1;
/** The RTP payload type of Opus, as Discord sends audio. */
const OPUS = 120;

/** An event source of @discordjs/voice: a networking, its voice socket, its media socket. */
interface Source {
	on(event: string, listener: (...given: never[]) => void): unknown;
	off(event: string, listener: (...given: never[]) => void): unknown;
}

/** A member of a state the library types by its status: `networking` of a connection's, `ws` and `udp` of a networking's. */
function partOf(state: object | undefined, key: string): Source | undefined {
	const part: unknown = state ? Reflect.get(state, key) : undefined;
	return typeof part === "object" && part !== null
		? (part as Source)
		: undefined;
}

/** The networking a connection's state holds: a resume keeps it, a new media path is a new one. */
export function networkingOf(state: VoiceConnectionState): object | undefined {
	return partOf(state, "networking");
}

/** Whether a datagram on the media socket is audio: RTP version 2 that carries Opus, which neither a keep-alive, an IP discovery nor RTCP is. */
function isAudio(message: Uint8Array): boolean {
	return (
		message.length > 12 &&
		(message[0] ?? 0) >> 6 === 2 &&
		((message[1] ?? 0) & 0x7f) === OPUS
	);
}

/**
 * Hands the watch what a connection's sockets carry: each speaking state of the voice socket and
 * each audio datagram of the media socket. The library replaces the voice socket on a resume and
 * both with a new networking, so `follow` is called with each state of the connection and the
 * sockets are followed from there, as the library's own receiver follows them.
 */
export function hearingTaps(
	connection: VoiceConnection,
	watch: HearingWatch,
): { follow(state: VoiceConnectionState): void; stop(): void } {
	let networking: Source | undefined;
	let voice: Source | undefined;
	let media: Source | undefined;
	const packet = (given: {
		op?: unknown;
		d?: { user_id?: unknown; speaking?: unknown } | null;
	}): void => {
		if (given.op !== SPEAKING || !given.d) return;
		const { user_id: userId, speaking } = given.d;
		if (typeof userId !== "string" || typeof speaking !== "number") return;
		if (speaking & MICROPHONE) watch.speaking(userId);
	};
	const datagram = (message: Uint8Array): void => {
		if (!isAudio(message)) return;
		const ssrc = new DataView(
			message.buffer,
			message.byteOffset,
			message.byteLength,
		).getUint32(8);
		// A stand-in receiver keeps no such map: its audio is its speakers'.
		const named = connection.receiver.ssrcMap;
		watch.audio(!named || named.get(ssrc) !== undefined);
	};
	const bind = (): void => {
		const state: unknown = networking
			? Reflect.get(networking, "state")
			: undefined;
		const sockets = typeof state === "object" && state ? state : undefined;
		const nextVoice = partOf(sockets, "ws");
		const nextMedia = partOf(sockets, "udp");
		if (nextVoice !== voice) {
			voice?.off("packet", packet);
			nextVoice?.on("packet", packet);
			voice = nextVoice;
		}
		if (nextMedia !== media) {
			media?.off("message", datagram);
			nextMedia?.on("message", datagram);
			media = nextMedia;
		}
	};
	return {
		follow(state) {
			const next = partOf(state, "networking");
			if (next !== networking) {
				networking?.off("stateChange", bind);
				next?.on("stateChange", bind);
				networking = next;
			}
			bind();
		},
		stop() {
			networking?.off("stateChange", bind);
			voice?.off("packet", packet);
			media?.off("message", datagram);
			networking = voice = media = undefined;
		},
	};
}
