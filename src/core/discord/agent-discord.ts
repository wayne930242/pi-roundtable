import {
	AttachmentBuilder,
	ChannelType,
	type Client,
	ContainerBuilder,
	discordSort,
	type Guild,
	type Message,
	MessageFlags,
	type NonThreadGuildBasedChannel,
	SeparatorBuilder,
	SeparatorSpacingSize,
	type TextChannel,
	TextDisplayBuilder,
	type Webhook,
} from "discord.js";
import type {
	AgentCategory,
	AgentChannels,
	AgentPost,
	CategoryLayout,
	ChannelMessage,
	DashboardBoard,
} from "../agents/agent-ports.ts";
import { AgentError } from "../domain/errors.ts";
import type { InterimPosts } from "../domain/interim.ts";
import { messages } from "../i18n/index.ts";
import type { Logger } from "../log.ts";

const DASHBOARD_NAME = "dashboard";

/**
 * The agent server's Discord side: one webhook of the assistant's per channel, through which every
 * agent speaks under its own name and avatar, and new channels under an `Agents` or `Groups`
 * category.
 */
export class DiscordAgentChannels implements AgentChannels {
	readonly #client: Client;
	readonly #guildId: string;
	readonly #webhooks = new Map<string, Promise<Webhook>>();

	constructor(client: Client, guildId: string) {
		this.#client = client;
		this.#guildId = guildId;
	}

	async post(channelId: string, post: AgentPost): Promise<void> {
		const webhook = await this.#webhook(channelId);
		const as = {
			username: post.name,
			avatarURL: post.avatarUrl,
			allowedMentions: { parse: ["users" as const] },
			...(post.threadId ? { threadId: post.threadId } : {}),
		};
		try {
			if (post.thinking) await webhook.send({ ...as, content: post.thinking });
			for (const chunk of post.chunks)
				await webhook.send({ ...as, content: chunk });
			for (const file of post.files ?? [])
				await webhook.send({
					...as,
					files: [
						new AttachmentBuilder(Buffer.from(file.data), { name: file.name }),
					],
				});
		} catch (error) {
			// A webhook deleted by hand is found or made again on the next post.
			this.#webhooks.delete(channelId);
			throw error;
		}
	}

	interim(
		channelId: string,
		as: Omit<AgentPost, "thinking" | "chunks" | "files">,
	): InterimPosts {
		const threadId = as.threadId ? { threadId: as.threadId } : {};
		return {
			post: async (text) => {
				const webhook = await this.#webhook(channelId);
				try {
					const message = await webhook.send({
						username: as.name,
						avatarURL: as.avatarUrl,
						allowedMentions: { parse: ["users"] },
						...threadId,
						content: text,
					});
					return {
						edit: async (change) => {
							await webhook.editMessage(message, {
								content: change,
								...threadId,
							});
						},
					};
				} catch (error) {
					this.#webhooks.delete(channelId);
					throw error;
				}
			},
		};
	}

	async createChannel(
		name: string,
		topic: string,
		category: AgentCategory,
	): Promise<string> {
		const guild = await this.#client.guilds.fetch(this.#guildId);
		const parent = await this.#category(guild, category);
		const channel = await guild.channels.create({
			name,
			type: ChannelType.GuildText,
			parent: parent.id,
			topic: topic.slice(0, 1024),
		});
		return channel.id;
	}

	async placeIn(channelId: string, category: AgentCategory): Promise<boolean> {
		const text = await this.#text(channelId);
		const parent = await this.#category(text.guild, category);
		if (text.parentId === parent.id) return false;
		await text.setParent(parent.id, { lockPermissions: false });
		return true;
	}

	async layout(): Promise<CategoryLayout[]> {
		const guild = await this.#client.guilds.fetch(this.#guildId);
		const channels = (await guild.channels.fetch()).filter(
			(c): c is NonThreadGuildBasedChannel => c !== null,
		);
		const categories = channels.filter(
			(c) => c.type === ChannelType.GuildCategory,
		);
		return [...discordSort(categories).values()].map((category) => ({
			id: category.id,
			name: category.name,
			channelIds: [
				...discordSort(
					channels.filter((c) => c.parentId === category.id),
				).keys(),
			],
		}));
	}

	async arrange(layout: CategoryLayout[], remove: string[]): Promise<void> {
		const guild = await this.#client.guilds.fetch(this.#guildId);
		const current = await guild.channels.fetch();
		const positions: { channel: string; position: number }[] = [];
		for (const [index, category] of layout.entries()) {
			const id =
				category.id ??
				(
					await guild.channels.create({
						name: category.name,
						type: ChannelType.GuildCategory,
					})
				).id;
			positions.push({ channel: id, position: index });
			for (const [position, channelId] of category.channelIds.entries()) {
				// Discord's bulk position edit takes at most one parent change, so moves go one by one.
				const channel = current.get(channelId);
				if (channel && channel.parentId !== id)
					await channel.setParent(id, { lockPermissions: false });
				positions.push({ channel: channelId, position });
			}
		}
		await guild.channels.setPositions(positions);
		if (remove.length === 0) return;
		// Fetch the parents again before judging a category empty.
		const channels = await guild.channels.fetch();
		for (const id of remove) {
			const category = channels.get(id);
			if (
				category?.type === ChannelType.GuildCategory &&
				!channels.some((c) => c?.parentId === id)
			)
				await category.delete(messages().auditArranged);
		}
	}

	async setTopic(channelId: string, topic: string): Promise<void> {
		const text = await this.#text(channelId);
		// Discord allows two topic edits per channel in ten minutes; skip the ones that change nothing.
		if (text.topic !== topic.slice(0, 1024))
			await text.setTopic(topic.slice(0, 1024));
	}

	async removeWebhook(channelId: string): Promise<void> {
		this.#webhooks.delete(channelId);
		const webhook = await this.#find(await this.#text(channelId));
		await webhook?.delete(messages().auditArchived);
	}

	async exists(channelId: string): Promise<boolean> {
		const channel = await this.#client.channels
			.fetch(channelId)
			.catch(() => null);
		return channel !== null;
	}

	async read(
		channelId: string,
		options: { limit: number; around?: string },
	): Promise<ChannelMessage[]> {
		const channel = await this.#client.channels
			.fetch(channelId)
			.catch(() => null);
		if (
			!channel ||
			channel.isDMBased() ||
			channel.guildId !== this.#guildId ||
			!channel.isTextBased()
		)
			throw new AgentError(
				`<#${channelId}> is not a text channel or thread of the agent server.`,
			);
		const fetched = await channel.messages.fetch(
			options.around
				? { limit: options.limit, around: options.around }
				: { limit: options.limit },
		);
		return [...fetched.values()]
			.sort((a, b) => a.createdTimestamp - b.createdTimestamp)
			.map(channelMessage);
	}

	/** The category, made when missing. */
	async #category(guild: Guild, name: AgentCategory) {
		const channels = await guild.channels.fetch();
		return (
			channels.find(
				(c) => c?.type === ChannelType.GuildCategory && c.name === name,
			) ??
			(await guild.channels.create({ name, type: ChannelType.GuildCategory }))
		);
	}

	async #text(channelId: string): Promise<TextChannel> {
		const channel = await this.#client.channels.fetch(channelId);
		if (channel?.type !== ChannelType.GuildText)
			throw new AgentError(`channel ${channelId} is not a server text channel`);
		return channel as TextChannel;
	}

	#webhook(channelId: string): Promise<Webhook> {
		let pending = this.#webhooks.get(channelId);
		if (!pending) {
			pending = this.#findOrCreate(channelId);
			pending.catch(() => this.#webhooks.delete(channelId));
			this.#webhooks.set(channelId, pending);
		}
		return pending;
	}

	async #findOrCreate(channelId: string): Promise<Webhook> {
		const text = await this.#text(channelId);
		return (
			(await this.#find(text)) ??
			(await text.createWebhook({
				name: messages().webhookName,
				reason: messages().auditWebhook,
			}))
		);
	}

	async #find(text: TextChannel): Promise<Webhook | undefined> {
		const applicationId = this.#client.application?.id;
		return (await text.fetchWebhooks()).find(
			(w) =>
				w.name === messages().webhookName && w.applicationId === applicationId,
		);
	}
}

function channelMessage(message: Message): ChannelMessage {
	const forwarded = message.messageSnapshots.first()?.content;
	return {
		id: message.id,
		author:
			message.member?.displayName ??
			message.author.globalName ??
			message.author.username,
		at: message.createdAt,
		text: [message.content, forwarded ? `(forwarded) ${forwarded}` : ""]
			.filter(Boolean)
			.join("\n"),
		attachments: [...message.attachments.values()].map((a) => a.name),
	};
}

/**
 * `#dashboard` at the top of the agent server and the assistant's one message in it, found again after a
 * restart and made again when either is deleted. The message is pinned when the assistant has the Pin
 * Messages permission; it is found by its author either way.
 */
export class DiscordDashboard implements DashboardBoard {
	readonly #client: Client;
	readonly #guildId: string;
	readonly #logger: Logger;
	#message: Message | undefined;
	/** Whether pinning has been tried since startup, so a missing permission is reported once. */
	#pinTried = false;

	constructor(client: Client, guildId: string, logger: Logger) {
		this.#client = client;
		this.#guildId = guildId;
		this.#logger = logger;
	}

	async show(sections: string[]): Promise<void> {
		const container = new ContainerBuilder();
		sections.forEach((section, index) => {
			if (index > 0)
				container.addSeparatorComponents(
					new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small),
				);
			container.addTextDisplayComponents(
				new TextDisplayBuilder().setContent(section),
			);
		});
		const body = {
			components: [container],
			allowedMentions: { parse: [] },
		};
		const message = this.#message ?? (await this.#find());
		if (message) {
			try {
				this.#message = await message.edit(body);
				await this.#pin(this.#message);
				return;
			} catch (error) {
				this.#message = undefined;
				// A message deleted by hand is made again; anything else is the caller's to log.
				if (!(await this.#gone(message))) throw error;
			}
		}
		const channel = await this.#channel();
		const posted = await channel.send({
			...body,
			flags: MessageFlags.IsComponentsV2,
		});
		this.#message = posted;
		await this.#pin(posted);
	}

	/** Pins the dashboard message once per startup, when it is not pinned yet. */
	async #pin(message: Message): Promise<void> {
		if (message.pinned || this.#pinTried) return;
		this.#pinTried = true;
		await message
			.pin()
			.catch((error: unknown) =>
				this.#logger.warn(
					{ err: error },
					"dashboard message not pinned; grant the assistant Pin Messages in the agent server",
				),
			);
	}

	/** The assistant's latest message in the dashboard channel, if both exist. */
	async #find(): Promise<Message | undefined> {
		const channel = await this.#channel();
		const botId = this.#client.user?.id;
		const recent = await channel.messages.fetch({ limit: 50 });
		return recent.find((message) => message.author.id === botId);
	}

	async #gone(message: Message): Promise<boolean> {
		return message.channel.messages
			.fetch(message.id)
			.then(() => false)
			.catch(() => true);
	}

	async #channel(): Promise<TextChannel> {
		const guild = await this.#client.guilds.fetch(this.#guildId);
		const channels = await guild.channels.fetch();
		const found = channels.find(
			(c) =>
				c?.type === ChannelType.GuildText &&
				c.name === DASHBOARD_NAME &&
				c.parentId === null,
		);
		if (found) {
			const text = found as TextChannel;
			const topic = messages().dashTopic;
			if (text.topic !== topic) await text.setTopic(topic);
			return text;
		}
		return guild.channels.create({
			name: DASHBOARD_NAME,
			type: ChannelType.GuildText,
			position: 0,
			topic: messages().dashTopic,
		});
	}
}
