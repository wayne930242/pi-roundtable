import { EventEmitter } from "node:events";
import {
	AudioReceiveStream,
	EndBehaviorType,
	type JoinVoiceChannelOptions,
	VoiceConnectionDisconnectReason,
	VoiceConnectionStatus,
} from "@discordjs/voice";
import {
	ChannelType,
	type Client,
	DiscordAPIError,
	Events,
	PermissionFlagsBits,
} from "discord.js";
import {
	type RecordingLogger,
	recordingLogger,
} from "../../testing/recording-logger.ts";
import type { VoiceMember } from "./voice.ts";
import { type ManualVoiceClock, manualVoiceClock } from "./voice-clock.ts";
import type { VoiceSubject, VoiceWorld } from "./voice-contract.ts";
import { discordVoiceGateway } from "./voice-discord.ts";
import type { OpusDecoder, VoiceLib } from "./voice-link.ts";
import { type VoiceService, voiceService } from "./voice-service.ts";

// The Discord plugin's voice over stand-ins of what it stands on: a discord.js client that answers
// what the gateway reads, and a `joinVoiceChannel` whose connection a test drives. Everything
// above the two libraries is the real code.

const BOT = "900000000000000001";

type ChannelSpec = Parameters<VoiceWorld["channel"]>[1];

/** The state of a stand-in connection, as @discordjs/voice shapes it. */
interface StubState {
	status: VoiceConnectionStatus;
	reason?: VoiceConnectionDisconnectReason;
	closeCode?: number;
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

/** A voice connection a test drives: its state, the packets it hears, and what the link asked of it. */
export class StubConnection extends EventEmitter {
	state: StubState = { status: VoiceConnectionStatus.Signalling };
	readonly joinConfig: JoinVoiceChannelOptions;
	/** How often the link asked to join again. */
	rejoins = 0;
	/** What `rejoin()` answers: whether the main gateway carried the request. */
	carries = true;
	readonly receiver: {
		speaking: EventEmitter;
		subscriptions: Map<string, StubStream | AudioReceiveStream>;
		subscribe(userId: string): StubStream | AudioReceiveStream;
	};
	readonly #onDestroy: () => void;

	constructor(
		joinConfig: JoinVoiceChannelOptions,
		realStreams: boolean,
		onDestroy: () => void,
	) {
		super();
		this.joinConfig = joinConfig;
		this.#onDestroy = onDestroy;
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

	ready(): void {
		this.to({ status: VoiceConnectionStatus.Ready });
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
	rejoin(): boolean {
		if (this.state.status === VoiceConnectionStatus.Destroyed) return false;
		const notReady = this.state.status !== VoiceConnectionStatus.Ready;
		if (notReady) this.rejoins++;
		if (this.carries) {
			if (notReady) this.to({ status: VoiceConnectionStatus.Signalling });
			return true;
		}
		this.to({
			status: VoiceConnectionStatus.Disconnected,
			reason: VoiceConnectionDisconnectReason.AdapterUnavailable,
		});
		return false;
	}

	destroy(): void {
		if (this.state.status === VoiceConnectionStatus.Destroyed)
			throw new Error(
				"Cannot destroy VoiceConnection - it has already been destroyed",
			);
		this.to({ status: VoiceConnectionStatus.Destroyed });
		this.#onDestroy();
	}

	/** One packet of a speaker arrives, as the receiver hands it on: the speaking map first, then their stream. */
	packet(userId: string, packet: Uint8Array): void {
		this.receiver.speaking.emit("start", userId);
		const stream = this.receiver.subscriptions.get(userId);
		if (stream instanceof AudioReceiveStream) stream.push(Buffer.from(packet));
		else stream?.emit("data", packet);
	}
}

export interface DiscordVoiceWorld extends VoiceSubject {
	voice: VoiceService;
	clock: ManualVoiceClock;
	logs: RecordingLogger;
	client: Client;
	/** Every connection the stand-in `joinVoiceChannel` made, in order; none with the library itself. */
	connections: StubConnection[];
	/** The main gateway as a voice connection of the library itself sees it: how many payloads it was given, and `send` answers whether it carried one. */
	adapter: { sends: number; send: () => boolean };
	/** How often the voice library and the decoders were loaded. */
	loads: { lib: number; decoders: number };
	/** How many decoders were made and freed. */
	decoders: { made: number; freed: number };
}

/**
 * The real voice service and gateway over a stand-in client and voice library. `connect: false`
 * leaves a new connection signalling until the test calls `ready()`; `realStreams` gives the
 * receiver @discordjs/voice's own stream class; `decode` replaces the decoder that hands a packet
 * on as it is, and `decoders` the maker of decoders; `lib` is the voice library itself in place of
 * the stand-in connection, over the world's `adapter`.
 */
export function discordVoiceWorld(
	options: {
		connect?: boolean;
		realStreams?: boolean;
		decode?: (packet: Uint8Array) => Uint8Array;
		decoders?: () => OpusDecoder;
		resumeMs?: number;
		lib?: VoiceLib;
	} = {},
): DiscordVoiceWorld {
	const clock = manualVoiceClock();
	const logs = recordingLogger();
	const channels = new Map<string, ChannelSpec>();
	/** Where everyone is, by user id. */
	const states = new Map<string, { channelId: string; member: VoiceMember }>();
	const connections: StubConnection[] = [];
	const loads = { lib: 0, decoders: 0 };
	const decoders = { made: 0, freed: 0 };
	const emitter = new EventEmitter();
	const adapter = { sends: 0, send: (): boolean => true };
	let online = true;

	const memberOf = (member: VoiceMember) => ({
		id: member.userId,
		user: { bot: member.bot },
		displayName: member.displayName,
	});
	const stateOf = (guildId: string, userId: string) => {
		const state = states.get(userId);
		return {
			id: userId,
			guild: guildOf(guildId),
			channelId: state?.channelId ?? null,
			member: state ? memberOf(state.member) : null,
		};
	};
	const guildOf = (guildId: string) => ({
		id: guildId,
		voiceAdapterCreator: () => ({
			sendPayload: () => {
				adapter.sends++;
				return adapter.send();
			},
			destroy: () => {},
		}),
		voiceStates: {
			get cache() {
				return new Map(
					[...states]
						.filter(
							([, state]) => channels.get(state.channelId)?.guildId === guildId,
						)
						.map(([userId]) => [userId, stateOf(guildId, userId)]),
				);
			},
		},
		members: {
			me: { id: BOT },
			fetch: async () => undefined,
		},
	});
	/** Someone's channel changes, as the gateway reports it: the state before, and the state now. */
	const move = (
		guildId: string,
		member: VoiceMember,
		channelId: string | undefined,
	) => {
		const before = stateOf(guildId, member.userId);
		if (channelId === undefined) states.delete(member.userId);
		else states.set(member.userId, { channelId, member });
		const now = {
			...stateOf(guildId, member.userId),
			member: memberOf(member),
		};
		emitter.emit(Events.VoiceStateUpdate, before, now);
	};
	const me: VoiceMember = { userId: BOT, bot: true, displayName: "bot" };

	// SAFETY: the voice gateway reads only these members of the client.
	const client = Object.assign(emitter, {
		isReady: () => online,
		user: { id: BOT },
		guilds: { cache: { get: (guildId: string) => guildOf(guildId) } },
		channels: {
			fetch: async (channelId: string) => {
				const channel = channels.get(channelId);
				if (!channel)
					throw new DiscordAPIError(
						{ message: "Unknown Channel", code: 10003 },
						10003,
						404,
						"GET",
						`/channels/${channelId}`,
						{},
					);
				const allowed = new Set([
					PermissionFlagsBits.ViewChannel,
					...(channel.forbidden ? [] : [PermissionFlagsBits.Connect]),
				]);
				return {
					type:
						channel.kind === "text"
							? ChannelType.GuildText
							: channel.kind === "stage"
								? ChannelType.GuildStageVoice
								: ChannelType.GuildVoice,
					guild: guildOf(channel.guildId),
					isDMBased: () => false,
					isVoiceBased: () => channel.kind !== "text",
					full: channel.full ?? false,
					permissionsFor: () => ({ has: (flag: bigint) => allowed.has(flag) }),
				};
			},
		},
	}) as unknown as Client;

	const lib: VoiceLib = options.lib ?? {
		VoiceConnectionStatus,
		VoiceConnectionDisconnectReason,
		EndBehaviorType,
		getVoiceConnection: ((guildId: string) =>
			connectionOf(guildId)) as unknown as VoiceLib["getVoiceConnection"],
		// SAFETY: the link uses only what `StubConnection` has of a voice connection.
		joinVoiceChannel: ((joinConfig: JoinVoiceChannelOptions) => {
			const connection = new StubConnection(
				joinConfig,
				options.realStreams ?? false,
				// The bot leaves the channel, which the gateway reports like anyone's leaving.
				() => move(joinConfig.guildId, me, undefined),
			);
			connections.push(connection);
			if (options.connect ?? true)
				queueMicrotask(() => {
					move(joinConfig.guildId, me, joinConfig.channelId);
					connection.ready();
				});
			return connection;
		}) as unknown as VoiceLib["joinVoiceChannel"],
	};

	const voice = voiceService({
		clock,
		logger: logs.logger,
		...(options.resumeMs === undefined ? {} : { resumeMs: options.resumeMs }),
		gateway: discordVoiceGateway(client, {
			logger: logs.logger,
			clock,
			lib: async () => {
				loads.lib++;
				return lib;
			},
			decoders: async () => {
				loads.decoders++;
				return () => {
					const made = options.decoders?.();
					decoders.made++;
					return {
						decode: (packet) =>
							made
								? made.decode(packet)
								: (options.decode?.(packet) ?? Uint8Array.from(packet)),
						free: () => {
							decoders.freed++;
							made?.free();
						},
					};
				};
			},
		}),
	});
	const connectionOf = (guildId: string) =>
		connections.findLast(
			(connection) =>
				connection.joinConfig.guildId === guildId &&
				connection.state.status !== VoiceConnectionStatus.Destroyed,
		);

	return {
		voice,
		clock,
		logs,
		client,
		connections,
		adapter,
		loads,
		decoders,
		world: {
			botId: BOT,
			channel: (channelId, channel) => {
				channels.set(channelId, channel);
				for (const member of channel.members ?? [])
					states.set(member.userId, { channelId, member });
			},
			enter: (channelId, member) => {
				const guildId = channels.get(channelId)?.guildId;
				if (guildId) move(guildId, member, channelId);
			},
			exit: (channelId, userId) => {
				const state = states.get(userId);
				const guildId = channels.get(channelId)?.guildId;
				if (guildId && state?.channelId === channelId)
					move(guildId, state.member, undefined);
			},
			audio: (channelId, userId, pcm) => {
				const guildId = channels.get(channelId)?.guildId;
				const connection = guildId ? connectionOf(guildId) : undefined;
				if (connection?.joinConfig.channelId === channelId)
					connection.packet(userId, pcm);
				clock.advance(pcm.byteLength / 96);
			},
			quiet: () => clock.advance(5_000),
			drop: (guildId, how) => {
				const connection = connectionOf(guildId);
				if (!connection) return;
				if (how === "moved")
					return move(
						guildId,
						me,
						`${connection.joinConfig.channelId}-elsewhere`,
					);
				if (how === "removed") {
					connection.disconnected(4014);
					return move(guildId, me, undefined);
				}
				// The main gateway is down for good: every rejoin is refused until the resume time is over.
				connection.carries = false;
				connection.disconnected();
				clock.advance(30_000);
			},
			offline: () => {
				online = false;
			},
			stop: () => voice.stop(),
		},
	};
}
