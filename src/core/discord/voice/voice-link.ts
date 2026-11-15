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
	| "getVoiceConnection"
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
 * How long a speaker is quiet before their decoder is freed. opusscript's decoders share one
 * fixed heap, which holds 79 of them in the whole process: one more decodes nothing until others
 * are freed. So a decoder is kept only for who is speaking, not for everyone who ever spoke.
 */
const DECODER_IDLE_MS = 60_000;

/** One speaker's decoder, and when it last had a packet. */
interface Hearing {
	decoder: OpusDecoder;
	lastAt: number;
	/** Runs when the speaker may have been quiet for `DECODER_IDLE_MS`. */
	timer: unknown;
}

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
	const { guildId, channelId } = options;
	let connection: VoiceConnection | undefined;
	try {
		connection = lib.joinVoiceChannel({
			guildId,
			channelId,
			group: GROUP,
			adapterCreator: options.adapterCreator,
			selfDeaf: false,
			selfMute: true,
		});
		return linkOver(lib, connection, options);
	} catch (error) {
		// Not left behind: the library keeps a connection by guild, even one whose join threw, and hands it to the guild's next join.
		const left = connection ?? lib.getVoiceConnection(guildId, GROUP);
		try {
			if (left && left.state.status !== lib.VoiceConnectionStatus.Destroyed)
				left.destroy();
		} catch {
			// The library forgot the connection before this threw; the failure to report is the first.
		}
		throw error;
	}
}

/** The link over a connection the library made: what `openVoiceLink` answers. */
function linkOver(
	lib: VoiceLib,
	connection: VoiceConnection,
	options: VoiceLinkOptions,
): VoiceLink {
	const { guildId, channelId, logger } = options;
	const clock = options.clock ?? systemClock;
	const { VoiceConnectionStatus: Status } = lib;
	const decoders = new Map<string, Hearing>();
	/** How many packets of each speaker were not decoded. */
	const undecoded = new Map<string, number>();
	const subscribed = new Set<string>();
	let handlers: VoiceLinkHandlers | undefined;
	let closed = false;
	/** The timer of the next rejoin, while the last one was refused. */
	let rejoin: unknown;
	/** Whether a rejoin is being asked for right now. */
	let rejoining = false;

	const statusOf = (state: VoiceConnectionState): VoiceLinkStatus => {
		if (state.status === Status.Ready) return "ready";
		return state.status === Status.Destroyed ? "closed" : "reconnecting";
	};

	/**
	 * A connection the main gateway dropped is asked for again, once now and once every `REJOIN_MS`
	 * until it is carried; Discord's own disconnect is not. Whoever owns the link ends the waiting
	 * by closing it.
	 */
	const recover = (state: VoiceConnectionState): void => {
		// `rejoin()` reports its own outcome as a state change before it answers: that one is not a drop to recover from.
		if (rejoining) return;
		clock.clearTimeout(rejoin);
		rejoin = undefined;
		if (closed || state.status !== Status.Disconnected) return;
		const refused =
			state.reason === lib.VoiceConnectionDisconnectReason.WebSocketClose &&
			state.closeCode === DISCONNECTED;
		if (refused) return;
		let carried: boolean;
		rejoining = true;
		try {
			carried = connection.rejoin();
		} finally {
			rejoining = false;
		}
		if (carried) return;
		rejoin = clock.setTimeout(() => retry(), REJOIN_MS);
	};

	/** A later rejoin that throws is a refused one: warned, no audio, asked for again. */
	const retry = (): void => {
		try {
			recover(connection.state);
		} catch (error) {
			logger.warn(
				{
					guildId,
					channelId,
					reason: error instanceof Error ? error.message : String(error),
				},
				"voice rejoin failed",
			);
			rejoin = clock.setTimeout(() => retry(), REJOIN_MS);
		}
	};

	/** Frees a speaker's decoder; their next packet makes a new one. */
	const forget = (userId: string): void => {
		const hearing = decoders.get(userId);
		if (!hearing) return;
		decoders.delete(userId);
		clock.clearTimeout(hearing.timer);
		hearing.decoder.free();
	};

	/** The idle timer ran: the decoder is freed if no packet came since, else the timer waits out the rest. */
	const idle = (userId: string): void => {
		const hearing = decoders.get(userId);
		if (!hearing) return;
		const left = hearing.lastAt + DECODER_IDLE_MS - clock.now();
		if (left > 0) hearing.timer = clock.setTimeout(() => idle(userId), left);
		else forget(userId);
	};

	/** One packet through its speaker's decoder, which is made when first needed; undefined for a packet that was not decoded. */
	const decode = (
		userId: string,
		packet: Uint8Array,
	): Uint8Array | undefined => {
		try {
			let hearing = decoders.get(userId);
			if (!hearing) {
				hearing = { decoder: options.decoder(), lastAt: 0, timer: undefined };
				hearing.timer = clock.setTimeout(() => idle(userId), DECODER_IDLE_MS);
				decoders.set(userId, hearing);
			}
			hearing.lastAt = clock.now();
			return hearing.decoder.decode(packet);
		} catch (error) {
			// Counted and named by its speaker, once; never logged with its bytes.
			const lost = (undecoded.get(userId) ?? 0) + 1;
			undecoded.set(userId, lost);
			if (lost === 1)
				logger.warn(
					{
						guildId,
						userId,
						reason: error instanceof Error ? error.message : String(error),
					},
					"voice packet not decoded",
				);
			// The decoder may be one the heap had no room for: the next packet gets a new one, which decodes once others were freed.
			forget(userId);
			return undefined;
		}
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
			const pcm = decode(userId, packet);
			if (pcm) handlers?.frame(userId, pcm);
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
		for (const userId of [...decoders.keys()]) forget(userId);
		let lost = 0;
		for (const count of undecoded.values()) lost += count;
		if (lost > 0)
			logger.warn(
				{ guildId, undecoded: lost, speakers: undecoded.size },
				"voice packets were not decoded",
			);
	};

	recover(connection.state);
	return {
		status: () => (closed ? "closed" : statusOf(connection.state)),
		listen: (given) => {
			handlers = given;
		},
		forget,
		close: () => {
			release();
			// Tells Discord the bot left the channel; reports `closed` through the state change.
			if (connection.state.status !== Status.Destroyed) connection.destroy();
		},
	};
}
