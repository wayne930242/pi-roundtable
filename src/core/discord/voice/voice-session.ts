import type { Logger } from "../../kernel/log.ts";
import {
	VOICE_PCM,
	type VoiceDisconnectEvent,
	type VoiceDisconnectReason,
	type VoiceMember,
	type VoiceMemberEvent,
	type VoiceSession,
	type VoiceSpeakingEvent,
	type VoiceUtterance,
} from "./voice.ts";
import type { VoiceClock } from "./voice-clock.ts";

/** Bytes of `VOICE_PCM` audio in one millisecond. */
const BYTES_PER_MS =
	(VOICE_PCM.sampleRate * VOICE_PCM.channels * VOICE_PCM.bytesPerSample) /
	1_000;

export interface VoiceSessionOptions {
	guildId: string;
	channelId: string;
	members: readonly VoiceMember[];
	silenceMs: number;
	maxUtteranceMs: number;
	clock: VoiceClock;
	logger: Logger;
	/** What `leave()` does: the service closes the connection and ends the session. */
	leave: () => void;
}

/** One speaker's utterance while it is still heard. */
interface OpenUtterance {
	chunks: Uint8Array[];
	bytes: number;
	startedAt: number;
	lastAt: number;
	timer: unknown;
}

class Listeners<T> {
	readonly #listeners = new Set<(event: T) => void>();
	readonly #logger: Logger;
	readonly #what: string;
	constructor(logger: Logger, what: string) {
		this.#logger = logger;
		this.#what = what;
	}
	add(listener: (event: T) => void): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}
	emit(event: T): void {
		for (const listener of [...this.#listeners]) this.call(listener, event);
	}
	/** Never logs the event: an utterance holds audio. */
	call(listener: (event: T) => void, event: T): void {
		try {
			listener(event);
		} catch (error) {
			this.#logger.error({ err: error }, `voice ${this.#what} listener failed`);
		}
	}
	clear(): void {
		this.#listeners.clear();
	}
}

/**
 * A voice session's own state: who is in the channel, and each speaker's audio cut into
 * utterances. Whatever holds the connection (the Discord service, or a test's stand-in) feeds it
 * members and decoded frames and ends it; it keeps audio only until the utterance is delivered.
 */
export class VoiceSessionState implements VoiceSession {
	readonly guildId: string;
	readonly channelId: string;
	readonly #options: VoiceSessionOptions;
	readonly #members = new Map<string, VoiceMember>();
	readonly #open = new Map<string, OpenUtterance>();
	readonly #maxBytes: number;
	readonly #member: Listeners<VoiceMemberEvent>;
	readonly #speaking: Listeners<VoiceSpeakingEvent>;
	readonly #utterance: Listeners<VoiceUtterance>;
	readonly #disconnect: Listeners<VoiceDisconnectEvent>;
	#ended: VoiceDisconnectReason | undefined;

	constructor(options: VoiceSessionOptions) {
		this.#options = options;
		this.guildId = options.guildId;
		this.channelId = options.channelId;
		this.#maxBytes = options.maxUtteranceMs * BYTES_PER_MS;
		for (const member of options.members)
			this.#members.set(member.userId, member);
		this.#member = new Listeners(options.logger, "member");
		this.#speaking = new Listeners(options.logger, "speaking");
		this.#utterance = new Listeners(options.logger, "utterance");
		this.#disconnect = new Listeners(options.logger, "disconnect");
	}

	members(): VoiceMember[] {
		return [...this.#members.values()];
	}

	onMember(listener: (event: VoiceMemberEvent) => void): () => void {
		return this.#member.add(listener);
	}

	onSpeaking(listener: (event: VoiceSpeakingEvent) => void): () => void {
		return this.#speaking.add(listener);
	}

	onUtterance(listener: (utterance: VoiceUtterance) => void): () => void {
		return this.#utterance.add(listener);
	}

	onDisconnect(listener: (event: VoiceDisconnectEvent) => void): () => void {
		const reason = this.#ended;
		if (reason === undefined) return this.#disconnect.add(listener);
		queueMicrotask(() => this.#disconnect.call(listener, { reason }));
		return () => undefined;
	}

	ended(): VoiceDisconnectReason | undefined {
		return this.#ended;
	}

	async leave(): Promise<void> {
		if (this.#ended === undefined) this.#options.leave();
	}

	/** Someone is in the channel: reported as joined unless they already were. */
	memberJoined(member: VoiceMember): void {
		if (this.#ended !== undefined) return;
		const known = this.#members.has(member.userId);
		this.#members.set(member.userId, member);
		if (!known) this.#member.emit({ kind: "joined", member });
	}

	/** Someone is no longer in the channel: what they were saying is delivered first. */
	memberLeft(userId: string): void {
		const member = this.#members.get(userId);
		if (this.#ended !== undefined || !member) return;
		this.#finish(userId);
		this.#members.delete(userId);
		this.#member.emit({ kind: "left", member });
	}

	/** One decoded frame of a speaker, in the `VOICE_PCM` format; the caller keeps no reference to it. */
	frame(userId: string, pcm: Uint8Array): void {
		if (this.#ended !== undefined || pcm.byteLength === 0) return;
		const { clock, silenceMs } = this.#options;
		const now = clock.now();
		let open = this.#open.get(userId);
		if (!open) {
			open = { chunks: [], bytes: 0, startedAt: now, lastAt: now, timer: 0 };
			open.timer = clock.setTimeout(() => this.#quiet(userId), silenceMs);
			this.#open.set(userId, open);
			this.#speaking.emit({ userId, speaking: true, at: now });
		}
		open.chunks.push(pcm);
		open.bytes += pcm.byteLength;
		open.lastAt = now;
		if (open.bytes >= this.#maxBytes) {
			// The speaker goes on: the next frame carries on from here, in the same breath. The open
			// utterance is emptied before its audio is handed over, so a listener that ends the session
			// there is not handed the same audio again.
			const cut = { ...open };
			open.chunks = [];
			open.bytes = 0;
			open.startedAt = now;
			this.#deliver(userId, cut, true);
		}
	}

	/** Ends the session, once: every open utterance is delivered, then the disconnect is reported. */
	end(reason: VoiceDisconnectReason): void {
		if (this.#ended !== undefined) return;
		for (const userId of [...this.#open.keys()]) this.#finish(userId);
		this.#ended = reason;
		this.#members.clear();
		this.#disconnect.emit({ reason });
		for (const listeners of [
			this.#member,
			this.#speaking,
			this.#utterance,
			this.#disconnect,
		])
			listeners.clear();
	}

	/** The silence timer fired: the utterance ends if nothing came since, else the timer waits out the rest. */
	#quiet(userId: string): void {
		const open = this.#open.get(userId);
		if (!open) return;
		const { clock, silenceMs } = this.#options;
		const left = open.lastAt + silenceMs - clock.now();
		if (left > 0) {
			open.timer = clock.setTimeout(() => this.#quiet(userId), left);
			return;
		}
		this.#finish(userId);
	}

	#finish(userId: string): void {
		const open = this.#open.get(userId);
		if (!open) return;
		this.#open.delete(userId);
		this.#options.clock.clearTimeout(open.timer);
		this.#speaking.emit({ userId, speaking: false, at: open.lastAt });
		if (open.bytes > 0) this.#deliver(userId, open, false);
	}

	#deliver(userId: string, open: OpenUtterance, continues: boolean): void {
		const pcm = new Uint8Array(open.bytes);
		let offset = 0;
		for (const chunk of open.chunks) {
			pcm.set(chunk, offset);
			offset += chunk.byteLength;
		}
		this.#utterance.emit({
			userId,
			pcm,
			startedAt: open.startedAt,
			endedAt: open.lastAt,
			continues,
		});
	}
}
