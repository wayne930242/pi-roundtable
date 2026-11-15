import type {
	DiscordGatewayAdapterCreator,
	VoiceConnection,
	VoiceConnectionState,
} from "@discordjs/voice";
import type { Logger } from "../../kernel/log.ts";
import { systemClock, type VoiceClock } from "./voice-clock.ts";
import type {
	VoiceLink,
	VoiceLinkHandlers,
	VoiceLinkStatus,
} from "./voice-service.ts";

/** What the link uses of @discordjs/voice, so a test gives a stand-in `joinVoiceChannel`. */
export type VoiceLib = Pick<
	typeof import("@discordjs/voice"),
	| "joinVoiceChannel"
	| "VoiceConnectionStatus"
	| "VoiceConnectionDisconnectReason"
	| "EndBehaviorType"
>;

/** One speaker's Opus decoder: packets in, `VOICE_PCM` frames out. Opus keeps state between packets, so each speaker has their own. */
export interface OpusDecoder {
	/** Throws for a packet that is no Opus. */
	decode(packet: Uint8Array): Uint8Array;
	free(): void;
}

/** Discord's voice close code for a bot that was disconnected, moved, or whose channel was deleted. */
const DISCONNECTED = 4014;
/** How often a connection the main gateway could not carry is asked for again. */
const REJOIN_MS = 3_000;
/** The voice connection group, so a connection another library opened in the guild is never taken for ours. */
const GROUP = "pi-roundtable";

/**
 * Loads @discordjs/voice with the DAVE library Discord's end-to-end encryption needs, which
 * nothing else in the host imports: a host without `discord.voice` never loads them.
 */
export async function loadVoiceLib(): Promise<VoiceLib> {
	try {
		const [lib] = await Promise.all([
			import("@discordjs/voice"),
			import("@snazzah/davey"),
		]);
		return lib;
	} catch (cause) {
		throw new Error(
			"discord.voice is on, but @discordjs/voice or @snazzah/davey could not be loaded. Install pi-roundtable's dependencies again (bun install), or set discord.voice to false.",
			{ cause },
		);
	}
}

/** Loads the Opus decoder (opusscript, WebAssembly: no native build) and answers a maker of 48 kHz mono decoders. */
export async function loadOpusDecoders(): Promise<() => OpusDecoder> {
	try {
		const { default: OpusScript } = await import("opusscript");
		return () => {
			// One channel: libopus mixes Discord's stereo down as it decodes.
			const decoder = new OpusScript(48_000, 1);
			return {
				decode: (packet) =>
					decoder.decode(
						Buffer.isBuffer(packet) ? packet : Buffer.from(packet),
					),
				free: () => decoder.delete(),
			};
		};
	} catch (cause) {
		throw new Error(
			"discord.voice is on, but opusscript could not be loaded. Install pi-roundtable's dependencies again (bun install), or set discord.voice to false.",
			{ cause },
		);
	}
}

export interface VoiceLinkOptions {
	guildId: string;
	channelId: string;
	adapterCreator: DiscordGatewayAdapterCreator;
	decoder: () => OpusDecoder;
	logger: Logger;
	/** What the rejoin attempts wait by. Default: the host's clock. */
	clock?: VoiceClock;
}

/**
 * Joins the channel muted and not deafened, and hears every speaker: each one's Opus packets,
 * already decrypted by @discordjs/voice (transport encryption and DAVE), are decoded here and
 * handed on as frames. The audio is never logged and never written anywhere.
 */
export function openVoiceLink(
	lib: VoiceLib,
	options: VoiceLinkOptions,
): VoiceLink {
	const { guildId, channelId, logger } = options;
	const clock = options.clock ?? systemClock;
	const { VoiceConnectionStatus: Status } = lib;
	const connection: VoiceConnection = lib.joinVoiceChannel({
		guildId,
		channelId,
		group: GROUP,
		adapterCreator: options.adapterCreator,
		selfDeaf: false,
		selfMute: true,
	});
	const decoders = new Map<string, OpusDecoder>();
	const subscribed = new Set<string>();
	let handlers: VoiceLinkHandlers | undefined;
	let closed = false;
	let rejoin: unknown;
	let undecoded = 0;

	const statusOf = (state: VoiceConnectionState): VoiceLinkStatus => {
		if (state.status === Status.Ready) return "ready";
		return state.status === Status.Destroyed ? "closed" : "reconnecting";
	};

	/** A connection the main gateway dropped is asked for again until it is carried; Discord's own disconnect is not. */
	const recover = (state: VoiceConnectionState): void => {
		clock.clearTimeout(rejoin);
		rejoin = undefined;
		if (closed || state.status !== Status.Disconnected) return;
		const refused =
			state.reason === lib.VoiceConnectionDisconnectReason.WebSocketClose &&
			state.closeCode === DISCONNECTED;
		if (refused || connection.rejoin()) return;
		rejoin = clock.setTimeout(() => recover(connection.state), REJOIN_MS);
	};

	const hear = (userId: string): void => {
		if (closed || subscribed.has(userId)) return;
		subscribed.add(userId);
		const stream = connection.receiver.subscribe(userId, {
			end: { behavior: lib.EndBehaviorType.Manual },
		});
		stream.on("data", (packet: Uint8Array) => {
			// A packet the stream still held when the link closed is not decoded: its decoder is freed.
			if (closed) return;
			let decoder = decoders.get(userId);
			if (!decoder) {
				decoder = options.decoder();
				decoders.set(userId, decoder);
			}
			let pcm: Uint8Array;
			try {
				pcm = decoder.decode(packet);
			} catch {
				// Counted, never logged with its bytes.
				if (undecoded++ === 0)
					logger.warn({ guildId, userId }, "voice packet not decoded");
				return;
			}
			handlers?.frame(userId, pcm);
		});
		// @discordjs/voice destroys the stream on a packet it cannot decrypt; the speaker is heard again from the next one.
		stream.on("error", (error: Error) =>
			logger.debug(
				{ guildId, userId, reason: error.message },
				"voice stream failed",
			),
		);
		stream.once("close", () => {
			subscribed.delete(userId);
			if (!closed && connection.state.status !== Status.Destroyed) hear(userId);
		});
	};

	connection.receiver.speaking.on("start", hear);
	connection.on("stateChange", (_before, state) => {
		recover(state);
		if (state.status === Status.Destroyed) release();
		handlers?.status(statusOf(state));
	});
	connection.on("error", (error) =>
		logger.warn({ guildId, channelId, err: error }, "voice connection error"),
	);

	const release = (): void => {
		if (closed) return;
		closed = true;
		clock.clearTimeout(rejoin);
		connection.receiver.speaking.off("start", hear);
		for (const stream of connection.receiver.subscriptions.values())
			stream.destroy();
		for (const decoder of decoders.values()) decoder.free();
		decoders.clear();
		if (undecoded > 0)
			logger.warn({ guildId, undecoded }, "voice packets were not decoded");
	};

	recover(connection.state);
	return {
		status: () => (closed ? "closed" : statusOf(connection.state)),
		listen: (given) => {
			handlers = given;
		},
		close: () => {
			release();
			// Tells Discord the bot left the channel; reports `closed` through the state change.
			if (connection.state.status !== Status.Destroyed) connection.destroy();
		},
	};
}
