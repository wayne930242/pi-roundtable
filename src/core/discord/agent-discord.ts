import {
	AttachmentBuilder,
	ChannelType,
	type Client,
	ContainerBuilder,
	DiscordAPIError,
	discordSort,
	type Guild,
	type Message,
	MessageFlags,
	type NonThreadGuildBasedChannel,
	SeparatorBuilder,
	SeparatorSpacingSize,
	type TextChannel,
	TextDisplayBuilder,
	ThreadAutoArchiveDuration,
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
import type { IntercomCard } from "../domain/conversation.ts";
import { AgentError } from "../domain/errors.ts";
import type { InterimPosts } from "../domain/interim.ts";
import { messages } from "../i18n/index.ts";
import type { Logger } from "../log.ts";
import { intercomFolds } from "../presentation/intercom.ts";
import { type IntercomTexts, intercomMessage } from "./intercom-cards.ts";

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
	/** The parent channel of each thread the agents live in, and null for a channel that is none. */
	readonly #parents = new Map<string, string | null>();
	/** Where the cards' whole texts are kept for their open buttons; without it a card posts as text. */
	readonly #texts: IntercomTexts | undefined;

	constructor(client: Client, guildId: string, texts?: IntercomTexts) {
		this.#client = client;
		this.#guildId = guildId;
		this.#texts = texts;
	}

	/**
	 * Where a post to `channelId` is sent: the channel whose webhook speaks, and the thread it
	 * speaks into. A temp knight's place is a thread, which has no webhook of its own.
	 */
	async #route(
		channelId: string,
		threadId: string | undefined,
	): Promise<{ hook: string; threadId?: string }> {
		let parent = this.#parents.get(channelId);
		if (parent === undefined) {
			const channel = await this.#client.channels.fetch(channelId);
			parent = channel?.isThread() ? (channel.parentId ?? null) : null;
			this.#parents.set(channelId, parent);
		}
		if (parent === null)
			return { hook: channelId, ...(threadId ? { threadId } : {}) };
		return { hook: parent, threadId: channelId };
	}

	async post(channelId: string, post: AgentPost): Promise<void> {
		const route = await this.#route(channelId, post.threadId);
		const webhook = await this.#webhook(route.hook);
		const as = {
			username: post.name,
			avatarURL: post.avatarUrl,
			allowedMentions: { parse: ["users" as const] },
			...(route.threadId ? { threadId: route.threadId } : {}),
		};
		try {
			if (post.intercom && this.#texts) {
				await webhook.send({ ...as, ...this.#card(post.intercom) });
				return;
			}
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
			this.#webhooks.delete(route.hook);
			throw error;
		}
	}

	/** A card's message, its whole text kept for the open button when the summary leaves part out. */
	#card(card: IntercomCard) {
		if (!this.#texts || !intercomFolds(card))
			return intercomMessage(card, undefined);
		const id = crypto.randomUUID();
		this.#texts.remember(id, card.text);
		return intercomMessage(card, id);
	}

	interim(
		channelId: string,
		as: Omit<AgentPost, "thinking" | "chunks" | "files">,
	): InterimPosts {
		return {
			post: async (text) => {
				const route = await this.#route(channelId, as.threadId);
				const threadId = route.threadId ? { threadId: route.threadId } : {};
				const webhook = await this.#webhook(route.hook);
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
					this.#webhooks.delete(route.hook);
					throw error;
				}
			},
		};
	}

	async createThread(parentChannelId: string, name: string): Promise<string> {
		const parent = await this.#text(parentChannelId);
		const thread = await parent.threads.create({
			name: name.slice(0, 100),
			// The longest a thread stays open untouched, so a quiet helper's place is not archived under it.
			autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
		});
		this.#parents.set(thread.id, parentChannelId);
		return thread.id;
	}

	async closeThread(threadId: string): Promise<void> {
		const thread = await this.#thread(threadId);
		// Locking needs Manage Threads; without it the thread is only archived.
		try {
			await thread.edit({ archived: true, locked: true });
		} catch {
			await thread.setArchived(true);
		}
	}

	async openThread(threadId: string): Promise<void> {
		const thread = await this.#thread(threadId);
		try {
			await thread.edit({ archived: false, locked: false });
		} catch {
			await thread.setArchived(false);
		}
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

	async #thread(threadId: string) {
		const channel = await this.#client.channels.fetch(threadId);
		if (!channel?.isThread())
			throw new AgentError(`channel ${threadId} is not a thread`);
		return channel;
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

/** Discord's 400 "Invalid Form Body": the payload is refused for this message, retrying it as is cannot help. */
function isInvalidForm(error: unknown): boolean {
	return (
		error instanceof DiscordAPIError &&
		error.status === 400 &&
		error.code === 50035
	);
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
			flags: MessageFlags.IsComponentsV2 as const,
		};
		const message = this.#message ?? (await this.#find());
		if (message) {
			try {
				this.#message = await message.edit(body);
				await this.#pin(this.#message);
				return;
			} catch (error) {
				this.#message = undefined;
				// A message deleted by hand is made again, and so is one Discord refuses to edit as
				// components v2 (an old v1 message): it is deleted and posted fresh, once. Anything
				// else is the caller's to log.
				const gone = await this.#gone(message);
				if (!gone && !isInvalidForm(error)) throw error;
				if (!gone)
					await message
						.delete()
						.catch((deleteError: unknown) =>
							this.#logger.warn(
								{ err: deleteError },
								"old dashboard message not deleted; a fresh one is posted beside it",
							),
						);
			}
		}
		const channel = await this.#channel();
		const posted = await channel.send(body);
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
		// Pinning the dashboard makes Discord post a "pinned a message" notice in the bot's name; a
		// system message cannot be edited, so it is never the dashboard.
		return recent.find(
			(message) => message.author.id === botId && !message.system,
		);
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
