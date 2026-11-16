import { EventEmitter } from "node:events";
import {
	type DiscordGatewayAdapterLibraryMethods,
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
import { StubConnection } from "./voice-contract-connection.ts";
import { discordVoiceGateway } from "./voice-discord.ts";
import type { OpusDecoder, VoiceLib } from "./voice-link.ts";
import { type VoiceService, voiceService } from "./voice-service.ts";

// The Discord plugin's voice over stand-ins of what it stands on: a discord.js client that answers
// what the gateway reads, and a `joinVoiceChannel` whose connection a test drives. Everything
// above the two libraries is the real code.

const BOT = "900000000000000001";

type ChannelSpec = Parameters<VoiceWorld["channel"]>[1];

export interface DiscordVoiceWorld extends VoiceSubject {
	voice: VoiceService;
	clock: ManualVoiceClock;
	logs: RecordingLogger;
	client: Client;
	/** Every connection the stand-in `joinVoiceChannel` made, in order; none with the library itself. */
	connections: StubConnection[];
	/** Whether a moderator deafened the bot in its guild: Discord then sends it no audio. */
	deafened: boolean;
	/** Who is in a channel changes with no word of it, as when the gateway identifies again and is sent the guild's voice states anew. */
	resync(channelId: string, members: VoiceMember[]): void;
	/**
	 * The main gateway as a voice connection of the library itself sees it: how many payloads it
	 * was given, `send` answers whether it carried one, and `carried` is told each one it did, with
	 * what the library hears the gateway's answer through.
	 */
	adapter: {
		sends: number;
		send: () => boolean;
		carried?: (
			payload: { d: { channel_id: string | null } },
			methods: DiscordGatewayAdapterLibraryMethods,
		) => void;
	};
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
	const adapter: DiscordVoiceWorld["adapter"] = {
		sends: 0,
		send: (): boolean => true,
	};
	let online = true;
	let deafened = false;

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
			serverDeaf: userId === BOT && deafened,
		};
	};
	const guildOf = (guildId: string) => ({
		id: guildId,
		voiceAdapterCreator: (methods: DiscordGatewayAdapterLibraryMethods) => ({
			sendPayload: (payload: { d: { channel_id: string | null } }) => {
				adapter.sends++;
				const carried = adapter.send();
				if (carried) adapter.carried?.(payload, methods);
				return carried;
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
			// The bot leaves the channel and enters it, which the gateway reports like anyone's doing so.
			const leaves = () => move(joinConfig.guildId, me, undefined);
			const connection: StubConnection = new StubConnection(
				joinConfig,
				options.realStreams ?? false,
				{
					destroyed: leaves,
					left: leaves,
					entered: () => {
						const channelId = connection.joinConfig.channelId;
						if (channelId) move(joinConfig.guildId, me, channelId);
					},
				},
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
		get deafened() {
			return deafened;
		},
		set deafened(value: boolean) {
			deafened = value;
		},
		resync: (channelId, members) => {
			for (const [userId, state] of states)
				if (state.channelId === channelId && userId !== BOT)
					states.delete(userId);
			for (const member of members)
				states.set(member.userId, { channelId, member });
		},
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
