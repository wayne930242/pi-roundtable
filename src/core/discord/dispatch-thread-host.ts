import {
	ChannelType,
	type Client,
	type Message,
	ThreadAutoArchiveDuration,
} from "discord.js";
import { splitReply } from "../presentation/reply-splitter.ts";
import type { ThreadHost } from "./dispatch-threads.ts";

/** Parents a dispatch thread may start in; DMs, threads, forums, and voice chats keep posting in place. */
const HOSTS: readonly ChannelType[] = [
	ChannelType.GuildText,
	ChannelType.GuildAnnouncement,
];

/** Dispatch threads over the bot's own connection; the bot posts everything in them. */
export class DiscordThreadHost implements ThreadHost {
	readonly #client: Pick<Client, "channels">;

	constructor(client: Pick<Client, "channels">) {
		this.#client = client;
	}

	async open(
		parentId: string,
		name: string,
		line: (thread?: string) => string,
	): Promise<string | undefined> {
		const parent = await this.#client.channels.fetch(parentId);
		if (!parent || !HOSTS.includes(parent.type) || !parent.isSendable())
			return undefined;
		const start: Message = await parent.send({ content: line() });
		let threadId: string;
		try {
			const thread = await start.startThread({
				name,
				// Outlasts the longest run, so a quiet worker's thread stays open.
				autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
			});
			threadId = thread.id;
		} catch (error) {
			await start.delete().catch(() => undefined);
			throw error;
		}
		await start
			.edit({ content: line(`<#${threadId}>`) })
			.catch(() => undefined);
		return threadId;
	}

	async post(threadId: string, text: string): Promise<void> {
		const thread = await this.#thread(threadId);
		for (const chunk of splitReply(text)) await thread.send({ content: chunk });
	}

	async close(threadId: string): Promise<void> {
		const thread = await this.#thread(threadId);
		// Locking needs Manage Threads; without it the thread is only archived.
		try {
			await thread.edit({ archived: true, locked: true });
		} catch {
			await thread.setArchived(true);
		}
	}

	async #thread(threadId: string) {
		const channel = await this.#client.channels.fetch(threadId);
		if (!channel?.isThread())
			throw new Error(`channel ${threadId} is not a thread`);
		return channel;
	}
}
