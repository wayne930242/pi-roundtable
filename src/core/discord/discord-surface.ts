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
	MessageReferenceType,
	Partials,
} from "discord.js";
import type { AttachmentRef } from "../domain/attachment.ts";
import type {
	ChannelKey,
	InboundMessage,
	OutboundReply,
} from "../domain/conversation.ts";
import type { ChatSurface, OwnerNotifier } from "../domain/ports.ts";
import { messages } from "../i18n/index.ts";
import type { Logger } from "../log.ts";
import { splitReply } from "../presentation/reply-splitter.ts";
import type { ComposedInteractions } from "../registry/interactions.ts";
import { DiscordAgentChannels, DiscordDashboard } from "./agent-discord.ts";
import { discordChannelExecutor } from "./channel-executor.ts";
import type { ChannelExecutor } from "./channel-operations.ts";
import { DiscordThreadHost } from "./dispatch-thread-host.ts";
import type { CardChannel } from "./owner-cards.ts";
import { DiscordOwnerOps } from "./owner-discord.ts";
import { stopPanel } from "./stop-button.ts";

const PREFIX = "discord:";
/** Discord's error code for a channel that does not exist or cannot be seen. */
const UNKNOWN_CHANNEL = 10003;

export type ChannelInfo =
	| { kind: "dm"; name: string }
	| { kind: "guild"; name: string; guild: string; guildId: string };
const TYPING_REFRESH_MS = 8_000;
/** A turn shorter than this shows no stop button, so quick answers do not flicker one. */
const STOP_PANEL_DELAY_MS = 5_000;

export interface DiscordSurfaceOptions {
	token: string;
	ownerId: string;
	/** How the owner is named in audit-log reasons and refusals. */
	ownerName: string;
	logger: Logger;
}

/**
 * ChatSurface and OwnerNotifier over discord.js. It reports message facts only; the
 * conversation service decides who is answered. The Message Content intent lets the agent
 * server's channels answer the owner without a mention; elsewhere the assistant still answers only
 * DMs and messages that mention it.
 */
export class DiscordSurface implements ChatSurface, OwnerNotifier {
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

	#interactions: ComposedInteractions = { commands: [], modules: [] };

	constructor(options: DiscordSurfaceOptions) {
		this.#options = options;
	}

	/** Slash commands and the modules that answer them; the commands are registered globally at startup. */
	useInteractions(interactions: ComposedInteractions): void {
		this.#interactions = interactions;
	}

	/** Channel operations for outside agents; undefined until the connection is ready. */
	channelExecutor(): ChannelExecutor | undefined {
		return this.#client.isReady()
			? discordChannelExecutor(this.#client)
			: undefined;
	}

	/** Discord reading and management for the owner's agent; calls fail until the connection is ready. */
	ownerDiscord(): DiscordOwnerOps {
		return new DiscordOwnerOps(
			this.#client,
			this.#options.ownerId,
			this.#options.ownerName,
		);
	}

	/** The agent server's channels and webhooks. */
	agentChannels(guildId: string): DiscordAgentChannels {
		return new DiscordAgentChannels(this.#client, guildId);
	}

	/** Threads for background dispatches, in the channel that started each. */
	threadHost(): DiscordThreadHost {
		return new DiscordThreadHost(this.#client);
	}

	/** The agent server's `#dashboard` and its pinned status message. */
	agentDashboard(guildId: string): DiscordDashboard {
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

	/** Reports deleted server channels by id; register before start. */
	onChannelDeleted(handler: (channelId: string) => void): void {
		this.#client.on(Events.ChannelDelete, (channel) => handler(channel.id));
	}

	async start(onMessage: (message: InboundMessage) => void): Promise<void> {
		const { logger, token } = this.#options;
		this.#client.on(Events.MessageCreate, (message) => {
			this.#toInbound(message)
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

	/** The owner's direct-message channel. */
	async ownerChannel(): Promise<ChannelKey> {
		const owner = await this.#client.users.fetch(this.#options.ownerId);
		return `${PREFIX}${(await owner.createDM()).id}`;
	}

	async notifyOwner(text: string): Promise<void> {
		const owner = await this.#client.users.fetch(this.#options.ownerId);
		for (const chunk of splitReply(text)) await owner.send({ content: chunk });
	}

	async stop(): Promise<void> {
		await this.#client.destroy();
	}

	async #toInbound(message: Message): Promise<InboundMessage | undefined> {
		const botId = this.#client.user?.id;
		if (!botId || message.author.id === botId) return undefined;
		const mention = new RegExp(`<@!?${botId}>`, "g");
		const reference = message.reference;
		// A forward also has a reference, to a message elsewhere; its copy is the snapshot.
		const forward =
			reference?.type === MessageReferenceType.Forward
				? message.messageSnapshots.first()
				: undefined;
		const referenced =
			reference?.messageId && !forward
				? await message.fetchReference().catch(() => undefined)
				: undefined;
		return {
			channel: `${PREFIX}${message.channelId}`,
			messageId: message.id,
			authorId: message.author.id,
			authorName:
				message.member?.displayName ??
				message.author.globalName ??
				message.author.username,
			authorIsBot: message.author.bot,
			...(message.member
				? { authorRoleIds: [...message.member.roles.cache.keys()] }
				: {}),
			...(message.webhookId
				? {
						webhookId: message.webhookId,
						// Webhooks the assistant created carry its application on every message they post.
						ownWebhook:
							message.applicationId !== null &&
							message.applicationId === (this.#client.application?.id ?? botId),
					}
				: {}),
			isDirect: message.channel.isDMBased(),
			...(message.guildId ? { guildId: message.guildId } : {}),
			mentionsBot: message.mentions.users.has(botId),
			repliesToBot: referenced?.author.id === botId,
			text: message.content.replace(mention, "").trim(),
			attachments: [
				...attachmentRefs(message),
				...(forward ? attachmentRefs(forward) : []),
			],
			...(forward && reference?.channelId
				? {
						forwarded: {
							text: forward.content ?? "",
							channelMention: `<#${reference.channelId}>`,
							url: `https://discord.com/channels/${reference.guildId ?? "@me"}/${reference.channelId}/${reference.messageId ?? ""}`,
						},
					}
				: {}),
			...(referenced
				? {
						reference: {
							text: referenced.content.replace(mention, "").trim(),
							attachments: attachmentRefs(referenced),
							...(referenced.webhookId
								? { webhookName: referenced.author.username }
								: {}),
						},
					}
				: {}),
		};
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

function attachmentRefs(
	message: Pick<Message, "attachments">,
): AttachmentRef[] {
	return [...message.attachments.values()].map((attachment) => ({
		url: attachment.url,
		name: attachment.name,
		...(attachment.contentType ? { contentType: attachment.contentType } : {}),
		size: attachment.size,
	}));
}
