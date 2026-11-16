import { EventEmitter } from "node:events";
import {
	AudioReceiveStream,
	EndBehaviorType,
	type JoinVoiceChannelOptions,
	VoiceConnectionDisconnectReason,
	VoiceConnectionStatus,
} from "@discordjs/voice";

// A voice connection a test drives, in place of @discordjs/voice's own: its state, the voice
// socket's word of who speaks, the datagrams it hears, and what the link asked of it.

/** The networking of a stand-in connection: the voice socket and the media socket, as the library's networking holds them. */
export class StubNetworking extends EventEmitter {
	state: { ws: EventEmitter; udp: EventEmitter } = {
		ws: new EventEmitter(),
		udp: new EventEmitter(),
	};

	/** The voice socket is replaced and the media socket kept, as when the library resumes its session. */
	resume(): void {
		const before = this.state;
		this.state = { ws: new EventEmitter(), udp: before.udp };
		this.emit("stateChange", before, this.state);
	}
}

/** The state of a stand-in connection, as @discordjs/voice shapes it. */
interface StubState {
	status: VoiceConnectionStatus;
	reason?: VoiceConnectionDisconnectReason;
	closeCode?: number;
	networking?: StubNetworking;
}

/** A receive stream that hands a packet on at once, where the library's own starts on the next tick. */
class StubStream extends EventEmitter {
	destroyed = false;
	destroy(error?: Error): void {
		if (this.destroyed) return;
		this.destroyed = true;
		if (error) this.emit("error", error);
		this.emit("close");
	}
}

/** What a stand-in connection tells the main gateway's side of the test. */
export interface StubConnectionHooks {
	/** The connection was destroyed. */
	destroyed(): void;
	/** The bot left the channel and stays connected to the guild: `disconnect()`. */
	left(): void;
	/** The bot entered the channel again after `disconnect()`. */
	entered(): void;
}

/** An audio datagram as Discord sends it: an RTP header of version 2 that carries Opus, and a payload nobody reads. */
const DATAGRAM = Uint8Array.from([
	0x80,
	0x78,
	...new Array<number>(18).fill(0),
]);

export class StubConnection extends EventEmitter {
	state: StubState = { status: VoiceConnectionStatus.Signalling };
	readonly joinConfig: JoinVoiceChannelOptions;
	/** How often the link asked to join again. */
	rejoins = 0;
	/** What `rejoin()` answers: whether the main gateway carried the request. */
	carries = true;
	/** How often the link had the networking set up again, and whether that can be done. */
	configures = 0;
	configurable = true;
	/** How often the link left the channel to join it again. */
	leaves = 0;
	/** The networking the connection is ready over; a new one after each rejoin and each `configureNetworking()`. */
	networking = new StubNetworking();
	readonly receiver: {
		speaking: EventEmitter;
		subscriptions: Map<string, StubStream | AudioReceiveStream>;
		subscribe(userId: string): StubStream | AudioReceiveStream;
	};
	readonly #hooks: StubConnectionHooks;
	#left = false;

	constructor(
		joinConfig: JoinVoiceChannelOptions,
		realStreams: boolean,
		hooks: StubConnectionHooks,
	) {
		super();
		this.joinConfig = joinConfig;
		this.#hooks = hooks;
		const subscriptions = new Map<string, StubStream | AudioReceiveStream>();
		this.receiver = {
			speaking: new EventEmitter(),
			subscriptions,
			subscribe: (userId) => {
				const stream = realStreams
					? new AudioReceiveStream({
							end: { behavior: EndBehaviorType.Manual },
						})
					: new StubStream();
				const closes: EventEmitter = stream;
				closes.once("close", () => subscriptions.delete(userId));
				subscriptions.set(userId, stream);
				return stream;
			},
		};
	}

	to(state: StubState): void {
		const before = this.state;
		this.state = state;
		this.emit("stateChange", before, state);
	}

	/** Ready over the networking it has: the one it had before a resume, a new one after a rejoin or `configureNetworking()`. */
	ready(): void {
		this.to({
			status: VoiceConnectionStatus.Ready,
			networking: this.networking,
		});
	}

	/** The voice socket dropped and the library is resuming its session: the media path stays. `ready()` completes it. */
	resuming(): void {
		this.to({
			status: VoiceConnectionStatus.Connecting,
			networking: this.networking,
		});
		this.networking.resume();
	}

	/** The connection drops: with 4014 Discord disconnected the bot, otherwise the main gateway could not carry it. */
	disconnected(closeCode?: number): void {
		this.to(
			closeCode === undefined
				? {
						status: VoiceConnectionStatus.Disconnected,
						reason: VoiceConnectionDisconnectReason.AdapterUnavailable,
					}
				: {
						status: VoiceConnectionStatus.Disconnected,
						reason: VoiceConnectionDisconnectReason.WebSocketClose,
						closeCode,
					},
		);
	}

	/** As the library's: a request the main gateway refuses leaves the connection disconnected, and says so before it answers. */
	rejoin(joinConfig?: { channelId: string | null }): boolean {
		if (this.state.status === VoiceConnectionStatus.Destroyed) return false;
		const notReady = this.state.status !== VoiceConnectionStatus.Ready;
		if (notReady) this.rejoins++;
		Object.assign(this.joinConfig, joinConfig);
		if (this.carries) {
			if (notReady) {
				this.networking = new StubNetworking();
				this.to({ status: VoiceConnectionStatus.Signalling });
			}
			if (this.#left) {
				this.#left = false;
				this.#hooks.entered();
			}
			return true;
		}
		this.to({
			status: VoiceConnectionStatus.Disconnected,
			reason: VoiceConnectionDisconnectReason.AdapterUnavailable,
		});
		return false;
	}

	/** As the library's: the networking is made anew, and the connection is connecting until `ready()`. */
	configureNetworking(): void {
		if (
			this.state.status === VoiceConnectionStatus.Destroyed ||
			!this.configurable
		)
			return;
		this.configures++;
		this.networking = new StubNetworking();
		this.to({
			status: VoiceConnectionStatus.Connecting,
			networking: this.networking,
		});
	}

	/** As the library's: the bot leaves the channel, the connection forgets which it was, and it can be asked to join one again. */
	disconnect(): boolean {
		if (
			this.state.status === VoiceConnectionStatus.Destroyed ||
			this.state.status === VoiceConnectionStatus.Signalling
		)
			return false;
		this.leaves++;
		this.#left = true;
		// SAFETY: the library's join config holds no channel after a disconnect, which its type here does not say.
		(this.joinConfig as { channelId: string | null }).channelId = null;
		this.to({
			status: VoiceConnectionStatus.Disconnected,
			reason: VoiceConnectionDisconnectReason.Manual,
		});
		this.#hooks.left();
		return true;
	}

	destroy(): void {
		if (this.state.status === VoiceConnectionStatus.Destroyed)
			throw new Error(
				"Cannot destroy VoiceConnection - it has already been destroyed",
			);
		this.to({ status: VoiceConnectionStatus.Destroyed });
		this.#hooks.destroyed();
	}

	/** The voice socket says someone's speaking state: `flags` 0 for not speaking. */
	speaking(userId: string, flags = 1): void {
		this.networking.state.ws.emit("packet", {
			op: 5,
			d: { user_id: userId, ssrc: 1, speaking: flags },
		});
	}

	/** One audio datagram arrives on the media socket, of a speaker the voice socket may not have named. */
	datagram(): void {
		this.networking.state.udp.emit("message", DATAGRAM);
	}

	/** One packet of a speaker arrives, as the receiver hands it on: the datagram, the speaking map, then their stream. */
	packet(userId: string, packet: Uint8Array): void {
		this.datagram();
		this.receiver.speaking.emit("start", userId);
		const stream = this.receiver.subscriptions.get(userId);
		if (stream instanceof AudioReceiveStream) stream.push(Buffer.from(packet));
		else stream?.emit("data", packet);
	}
}
