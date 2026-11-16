import {
	ChannelType,
	type Client,
	DiscordAPIError,
	Events,
	GatewayIntentBits,
	type Guild,
	type GuildMember,
	PermissionFlagsBits,
	RESTJSONErrorCodes,
	type VoiceState,
} from "discord.js";
import type { Logger } from "../../kernel/log.ts";
import type { VoiceMember } from "./voice.ts";
import type { VoiceClock } from "./voice-clock.ts";
import {
	loadOpusDecoders,
	loadVoiceLib,
	type OpusDecoder,
	openVoiceLink,
	type VoiceLib,
} from "./voice-link.ts";
import type { VoiceChannelFacts, VoiceGateway } from "./voice-service.ts";

/** The Guild Voice States intent, asked for only when the host turns `discord.voice` on; it is not privileged. */
export function voiceIntents(
	enabled: boolean | undefined,
): GatewayIntentBits[] {
	return enabled ? [GatewayIntentBits.GuildVoiceStates] : [];
}

export interface DiscordVoiceGatewayOptions {
	logger: Logger;
	/** Default: @discordjs/voice, loaded when first asked for. */
	lib?: () => Promise<VoiceLib>;
	/** Default: opusscript, loaded when first asked for. */
	decoders?: () => Promise<() => OpusDecoder>;
	/** What a connection's rejoin attempts wait by. Default: the host's clock. */
	clock?: VoiceClock;
}

function memberOf(member: GuildMember): VoiceMember {
	return {
		userId: member.id,
		bot: member.user.bot,
		displayName: member.displayName,
	};
}

/** Who a voice state is of; a member Discord sent no data for is named by their id. */
function memberOfState(state: VoiceState): VoiceMember {
	return state.member
		? memberOf(state.member)
		: { userId: state.id, bot: false, displayName: state.id };
}

/** Who is in the channel, without the bot: members the cache lacks are fetched first, then the list is read in one go. */
async function membersIn(
	guild: Guild,
	channelId: string,
	botId: string,
): Promise<VoiceMember[]> {
	const inChannel = () =>
		[...guild.voiceStates.cache.values()].filter(
			(state) => state.channelId === channelId && state.id !== botId,
		);
	for (const state of inChannel())
		if (!state.member)
			await guild.members.fetch(state.id).catch(() => undefined);
	return inChannel().map(memberOfState);
}

/**
 * The voice gateway over the Discord plugin's own client, which must hold the Guild Voice States
 * intent. Nothing of @discordjs/voice or the Opus decoder is loaded until `prepare` or `connect`.
 */
export function discordVoiceGateway(
	client: Client,
	options: DiscordVoiceGatewayOptions,
): VoiceGateway {
	const { logger } = options;
	let lib: Promise<VoiceLib> | undefined;
	let decoders: Promise<() => OpusDecoder> | undefined;
	const loaded = async () => {
		lib ??= (options.lib ?? loadVoiceLib)();
		decoders ??= (options.decoders ?? loadOpusDecoders)();
		return { lib: await lib, decoder: await decoders };
	};
	return {
		ready: () => client.isReady(),
		botId: () => client.user?.id,
		async channel(
			channelId,
		): Promise<VoiceChannelFacts | "gone" | "forbidden"> {
			const refusal = (error: unknown) => {
				if (!(error instanceof DiscordAPIError)) throw error;
				if (error.code === RESTJSONErrorCodes.UnknownChannel) return "gone";
				if (error.code === RESTJSONErrorCodes.MissingAccess) return "forbidden";
				throw error;
			};
			// Asked of Discord, not the cache: a join is rare, and its refusal should be true now.
			const channel = await client.channels
				.fetch(channelId, { force: true })
				.catch(refusal);
			if (channel === "gone" || channel === "forbidden") return channel;
			if (!channel) return "gone";
			if (channel.isDMBased())
				return {
					guildId: "",
					kind: "other",
					connectable: false,
					full: false,
					members: [],
				};
			const kind =
				channel.type === ChannelType.GuildVoice
					? "voice"
					: channel.type === ChannelType.GuildStageVoice
						? "stage"
						: "other";
			const { guild } = channel;
			const me = guild.members.me ?? (await guild.members.fetchMe());
			const may = channel.permissionsFor(me);
			return {
				guildId: guild.id,
				kind,
				connectable:
					may.has(PermissionFlagsBits.ViewChannel) &&
					may.has(PermissionFlagsBits.Connect),
				full:
					channel.isVoiceBased() &&
					channel.full &&
					!may.has(PermissionFlagsBits.MoveMembers),
				members:
					kind === "other" ? [] : await membersIn(guild, channelId, me.id),
			};
		},
		onVoiceState(listener) {
			client.on(Events.VoiceStateUpdate, (before, now) => {
				if (before.channelId === now.channelId) return;
				try {
					listener({
						guildId: now.guild.id,
						userId: now.id,
						channelId: now.channelId ?? undefined,
						member: memberOfState(now),
					});
				} catch (error) {
					logger.error({ err: error }, "voice state handler failed");
				}
			});
		},
		onReady(listener) {
			const ready = () => {
				try {
					listener();
				} catch (error) {
					logger.error({ err: error }, "voice gateway handler failed");
				}
			};
			// Ready once the shard has its guilds again, so their voice states are the new ones.
			client.on(Events.ShardReady, ready);
			client.on(Events.ShardResume, ready);
		},
		async prepare() {
			await loaded();
		},
		async connect({ guildId, channelId }) {
			const guild = client.guilds.cache.get(guildId);
			if (!guild) throw new Error(`the bot is not in the guild ${guildId}`);
			const { lib, decoder } = await loaded();
			return openVoiceLink(lib, {
				guildId,
				channelId,
				adapterCreator: guild.voiceAdapterCreator,
				decoder,
				logger,
				...(options.clock ? { clock: options.clock } : {}),
				deafened: () =>
					guild.voiceStates.cache.get(client.user?.id ?? "")?.serverDeaf ===
					true,
			});
		},
	};
}
