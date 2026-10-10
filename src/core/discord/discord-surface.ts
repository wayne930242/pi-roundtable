import {
	AttachmentBuilder,
	ChannelType,
	Client,
	DiscordAPIError,
	Events,
	GatewayIntentBits,
	type Interaction,
	type Message,
	MessageFlags,
	Partials,
} from "discord.js";
import type { AgentChannels, DashboardBoard } from "../agents/agent-ports.ts";
import type { ChatSurface } from "../contract/surface.ts";
import type {
	ChannelKey,
	InboundMessage,
	OutboundReply,
} from "../domain/conversation.ts";
import type { InterimPosts } from "../domain/interim.ts";
import type { OwnerNotifier } from "../domain/ports.ts";
import { messages } from "../i18n/index.ts";
import type { PromptScope, Prompts } from "../interactions/prompts.ts";
import type { Logger } from "../log.ts";
import type { OwnerOperations } from "../modules/discord-admin/discord-admin.ts";
import { splitReply } from "../presentation/reply-splitter.ts";
import { DiscordAgentChannels, DiscordDashboard } from "./agent-discord.ts";
import {
	type ContextSourceMessage,
	contextSourceOf,
} from "./channel-context.ts";
import { discordChannelExecutor } from "./channel-executor.ts";
import type { ChannelExecutor } from "./channel-operations.ts";
import type { ComposedCommands } from "./compose-commands.ts";
import type { ChannelInfo, DiscordConnection } from "./connection.ts";
import { DiscordThreadHost } from "./dispatch-thread-host.ts";
import { DEFAULT_FRESH_MARKER, postFreshMarker } from "./fresh-marker.ts";
import { toInbound } from "./inbound-message.ts";
import type { CardChannel } from "./owner-cards.ts";
import { DiscordOwnerOps } from "./owner-discord.ts";
import { stopPanel } from "./stop-button.ts";

const PREFIX = "discord:";
/** Discord's error code for a channel that does not exist or cannot be seen. */
const UNKNOWN_CHANNEL = 10003;

const TYPING_REFRESH_MS = 8_000;
/** A turn shorter than this shows no stop button, so quick answers do not flicker one. */
const STOP_PANEL_DELAY_MS = 5_000;

export interface DiscordSurfaceOptions {
	token: string;
	/** The primary owner's Discord user id, whom the admin tools act as and the deprecated owner channel reaches. */
	ownerId: string;
	/** How the primary owner is named in audit-log reasons and refusals. */
	ownerName: string;
	/** The cards in a Discord channel; the surface hands them out as its `prompts`. */
	prompts: (channel: ChannelKey, scope?: PromptScope) => Prompts | undefined;
	logger: Logger;
	/** The divider posted in a server channel when its conversation starts over; `false` posts none. Default: `DEFAULT_FRESH_MARKER`. */
	freshMarker?: string | false;
}

/**
 * ChatSurface and OwnerNotifier over discord.js. It reports message facts only; the
 * conversation service decides who is answered. The Message Content intent lets the agent
 * server's channels answer the owner without a mention; elsewhere the assistant still answers only
 * DMs and messages that mention it.
 */
export class DiscordSurface
	implements ChatSurface, OwnerNotifier, DiscordConnection
{
	readonly surface = "discord";
	readonly supportsFiles = true;
	readonly #options: DiscordSurfaceOptions;
	readonly #client = new Client({
		intents: [
			GatewayIntentBits.Guilds,
			GatewayIntentBits.GuildMessages,
			GatewayIntentBits.DirectMessages,
			GatewayIntentBits.MessageContent,
		],
		partials: [Partials.Channel],
		allowedMentions: { parse: [] },
	});

	#interactions: ComposedCommands = { commands: [], modules: [] };

	constructor(options: DiscordSurfaceOptions) {
		this.#options = options;
	}

	/** Slash commands and the modules that answer them; the commands are registered globally at startup. */
	setCommands(composed: ComposedCommands): void {
		this.#interactions = composed;
	}

	/** Channel operations for outside agents; undefined until the connection is ready. */
	channelExecutor(): ChannelExecutor | undefined {
		return this.#client.isReady()
			? discordChannelExecutor(this.#client)
			: undefined;
	}

	/** Discord reading and management for the owner's agent, as the primary owner may; calls fail until the connection is ready. */
	ownerOperations(): OwnerOperations {
		return new DiscordOwnerOps(
			this.#client,
			this.#options.ownerId,
			this.#options.ownerName,
		);
	}

	/** The agent server's channels and webhooks. */
	agentChannels(guildId: string): AgentChannels {
		return new DiscordAgentChannels(this.#client, guildId);
	}

	/** Threads for background dispatches, in the channel that started each. */
	threadHost(): DiscordThreadHost {
		return new DiscordThreadHost(this.#client);
	}

	/** The agent server's `#dashboard` and its pinned status message. */
	agentDashboard(guildId: string): DashboardBoard {
		return new DiscordDashboard(this.#client, guildId, this.#options.logger);
	}

	/**
	 * What a channel is called, for the web app's lists: undefined when Discord no longer knows
	 * it; throws while the connection is not ready or Discord cannot be reached.
	 */
	async channelInfo(channelId: string): Promise<ChannelInfo | undefined> {
		if (!this.#client.isReady()) throw new Error("Discord is not connected");
		const channel = await this.#client.channels
			.fetch(channelId)
			.catch((error: unknown) => {
				if (error instanceof DiscordAPIError && error.code === UNKNOWN_CHANNEL)
					return null;
				throw error;
			});
		if (!channel) return undefined;
		if (channel.isDMBased())
			return {
				kind: "dm",
				name:
					channel.type === ChannelType.DM
						? (channel.recipient?.username ?? "")
						: (channel.name ?? ""),
			};
		return {
			kind: "guild",
			name: channel.name,
			guild: channel.guild.name,
			guildId: channel.guild.id,
		};
	}

	/**
	 * A server text channel's messages before one, as channel context reads them; undefined for a
	 * direct message or a channel that holds no messages. Throws while the connection is not ready
	 * or when Discord refuses, such as for a channel the bot cannot read.
	 */
	async messagesBefore(
		channelId: string,
		before: string,
		limit: number,
	): Promise<ContextSourceMessage[] | undefined> {
		if (!this.#client.isReady()) throw new Error("Discord is not connected");
		const channel = await this.#client.channels.fetch(channelId);
		if (!channel?.isTextBased() || channel.isDMBased()) return undefined;
		const fetched = await channel.messages.fetch({ before, limit });
		const self = {
			botId: this.#client.user.id,
			applicationId: this.#client.application.id,
		};
		return [...fetched.values()].map((message) =>
			contextSourceOf(message, self),
		);
	}

	/** Reports deleted server channels by id; register before start. */
	onChannelDeleted(handler: (channelId: string) => void): void {
		this.#client.on(Events.ChannelDelete, (channel) => handler(channel.id));
	}

	/** The approval and question cards in a Discord channel, for those the scope names. */
	prompts(channel: ChannelKey, scope?: PromptScope): Prompts | undefined {
		return this.#options.prompts(channel, scope);
	}

	/** The channel's interim posts: ordinary messages, edited in place for the progress line. */
	interim(channel: ChannelKey): InterimPosts | undefined {
		if (!channel.startsWith(PREFIX)) return undefined;
		return {
			post: async (text) => {
				const target = await this.#sendable(channel);
				const message = await target.send({
					content: text,
					allowedMentions: { parse: ["users"] },
				});
				return {
					edit: async (change) => {
						await message.edit({ content: change });
					},
				};
			},
		};
	}

	async start(onMessage: (message: InboundMessage) => void): Promise<void> {
		const { logger, token } = this.#options;
		this.#client.on(Events.MessageCreate, (message) => {
			toInbound(message, {
				botId: this.#client.user?.id,
				applicationId: this.#client.application?.id,
			})
				.then((inbound) => {
					if (inbound) onMessage(inbound);
				})
				.catch((error: unknown) =>
					logger.error({ err: error }, "inbound message could not be read"),
				);
		});
		this.#client.on(Events.InteractionCreate, (interaction) => {
			void this.#dispatch(interaction);
		});
		this.#client.on(Events.Error, (error) =>
			logger.error({ err: error }, "discord client error"),
		);
		const ready = new Promise<void>((resolve) =>
			this.#client.once(Events.ClientReady, () => resolve()),
		);
		await this.#client.login(token);
		await ready;
		const { commands } = this.#interactions;
		await this.#client.application?.commands.set(commands);
		logger.info(
			{ user: this.#client.user?.tag, commands: commands.map((c) => c.name) },
			"discord ready",
		);
	}

	/**
	 * Discord draws attachments below a message's text, so the card goes out as its own message
	 * first and produced files last, each on its own. Replies may mention people but never everyone or a role.
	 */
	async sendReply(channel: ChannelKey, reply: OutboundReply): Promise<void> {
		const target = await this.#sendable(channel);
		const allowedMentions = { parse: ["users" as const] };
		if (reply.thinking) {
			await target.send({ content: reply.thinking, allowedMentions });
		}
		if (reply.card) {
			await target.send({
				files: [
					new AttachmentBuilder(Buffer.from(reply.card), {
						name: "card.png",
					}),
				],
			});
		}
		for (const chunk of reply.chunks) {
			await target.send({ content: chunk, allowedMentions });
		}
		// One file per message: Discord crops several images in one message into a grid.
		for (const file of reply.files ?? []) {
			await target.send({
				files: [
					new AttachmentBuilder(Buffer.from(file.data), { name: file.name }),
				],
			});
		}
	}

	/** The divider that ends channel context's window; see `postFreshMarker`. */
	async markFresh(channel: ChannelKey): Promise<void> {
		await postFreshMarker(
			this.#options.freshMarker ?? DEFAULT_FRESH_MARKER,
			async () => {
				const target = await this.#sendable(channel);
				return {
					dm: target.isDMBased(),
					send: (text) => target.send({ content: text }),
				};
			},
		);
	}

	startTyping(channel: ChannelKey): () => void {
		let stopped = false;
		const tick = () => {
			if (stopped) return;
			this.#sendable(channel)
				.then((target) => target.sendTyping())
				.catch((error: unknown) =>
					this.#options.logger.warn(
						{ channel, err: error },
						"typing indicator failed",
					),
				);
		};
		tick();
		const timer = setInterval(tick, TYPING_REFRESH_MS);
		return () => {
			stopped = true;
			clearInterval(timer);
		};
	}

	showStop(channel: ChannelKey): () => void {
		const { logger } = this.#options;
		// An outside agent's conversation has no Discord channel to show a button in.
		if (!channel.startsWith(PREFIX)) return () => undefined;
		let hidden = false;
		let panel: Message | undefined;
		const remove = (message: Message) =>
			message
				.delete()
				.catch((error: unknown) =>
					logger.warn({ channel, err: error }, "stop panel not removed"),
				);
		const timer = setTimeout(() => {
			this.#sendable(channel)
				.then((target): Promise<Message> => target.send(stopPanel()))
				.then((message) => {
					if (hidden) void remove(message);
					else panel = message;
				})
				.catch((error: unknown) =>
					logger.warn({ channel, err: error }, "stop panel not shown"),
				);
		}, STOP_PANEL_DELAY_MS);
		return () => {
			hidden = true;
			clearTimeout(timer);
			if (panel) void remove(panel);
		};
	}

	async react(
		channel: ChannelKey,
		messageId: string,
		emoji: string,
	): Promise<void> {
		try {
			const target = await this.#sendable(channel);
			await (await target.messages.fetch(messageId)).react(emoji);
		} catch (error) {
			this.#options.logger.warn({ channel, err: error }, "reaction not added");
		}
	}

	async unreact(
		channel: ChannelKey,
		messageId: string,
		emoji: string,
	): Promise<void> {
		try {
			const target = await this.#sendable(channel);
			const message = await target.messages.fetch(messageId);
			await message.reactions.cache
				.find((reaction) => reaction.emoji.name === emoji)
				?.users.remove();
		} catch (error) {
			this.#options.logger.warn(
				{ channel, err: error },
				"reaction not removed",
			);
		}
	}

	/** Where the owner's cards in a channel are posted. */
	async cardChannel(channelId: string): Promise<CardChannel> {
		const target = await this.#sendable(`${PREFIX}${channelId}`);
		return {
			thread: target.isThread(),
			send: async (payload) => {
				const message = await target.send(payload);
				return { edit: (change) => message.edit(change) };
			},
		};
	}

	/** A Discord user's direct-message channel. */
	async directChannel(userId: string): Promise<ChannelKey> {
		const user = await this.#client.users.fetch(userId);
		return `${PREFIX}${(await user.createDM()).id}`;
	}

	/** Sends a Discord user a direct message, split as a reply is. */
	async sendDirect(userId: string, text: string): Promise<void> {
		const user = await this.#client.users.fetch(userId);
		for (const chunk of splitReply(text)) await user.send({ content: chunk });
	}

	/** @deprecated The primary owner's direct-message channel; see `DiscordConnection.ownerChannel`. */
	async ownerChannel(): Promise<ChannelKey> {
		return this.directChannel(this.#options.ownerId);
	}

	/** @deprecated Sends the primary owner a direct message; see `DiscordConnection.notifyOwner`. */
	async notifyOwner(text: string): Promise<void> {
		await this.sendDirect(this.#options.ownerId, text);
	}

	async stop(): Promise<void> {
		await this.#client.destroy();
	}

	async #dispatch(interaction: Interaction): Promise<void> {
		const { logger } = this.#options;
		try {
			for (const module of this.#interactions.modules) {
				if (await module.handle(interaction)) return;
			}
		} catch (error) {
			logger.error({ err: error }, "interaction failed");
			if (
				interaction.isRepliable() &&
				!interaction.replied &&
				!interaction.deferred
			) {
				await interaction
					.reply({
						content: messages().surfaceActionFailed,
						flags: MessageFlags.Ephemeral,
					})
					.catch(() => undefined);
			}
		}
	}

	async #sendable(channel: ChannelKey) {
		if (!channel.startsWith(PREFIX))
			throw new Error(`not a Discord channel: ${channel}`);
		const target = await this.#client.channels.fetch(
			channel.slice(PREFIX.length),
		);
		if (!target?.isSendable())
			throw new Error(`channel ${channel} cannot receive messages`);
		return target;
	}
}
