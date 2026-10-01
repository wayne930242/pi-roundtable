import {
	type AnyThreadChannel,
	ChannelType,
	type Client,
	type Guild,
	type GuildMember,
	PermissionFlagsBits,
} from "discord.js";
import { fetchManagedChannel, fetchOwnerChannel } from "./channel-executor.ts";
import { type OwnerAccess, refuse } from "./owner-discord-access.ts";

/** The owner's agent's thread operations, bounded by what both the owner and the bot may do. */
export class OwnerThreads {
	readonly #client: Client;
	readonly #access: OwnerAccess;
	readonly #ownerId: string;
	/** The audit-log reason of an action taken without one of its own. */
	readonly #reason: string;

	constructor(
		client: Client,
		access: OwnerAccess,
		ownerId: string,
		reason: string,
	) {
		this.#client = client;
		this.#access = access;
		this.#ownerId = ownerId;
		this.#reason = reason;
	}

	/**
	 * Threads both can see: a private thread only when the owner may manage threads there,
	 * since Discord shows it to its members alone otherwise.
	 */
	async list(
		guild: Guild,
		owner: GuildMember,
		bot: GuildMember,
		args: Record<string, unknown>,
	) {
		const parentId =
			typeof args.parentId === "string" ? args.parentId : undefined;
		let threads: AnyThreadChannel[];
		if (args.archived === true) {
			if (!parentId)
				throw refuse("INVALID_ARGUMENT", "archived threads need parentId");
			const parent = await fetchManagedChannel(this.#client, parentId);
			if (parent.guildId !== guild.id)
				throw refuse("INVALID_CHANNEL", "parentId is not in that server");
			const fetched = await parent.threads.fetchArchived({ limit: 50 });
			threads = [...fetched.threads.values()];
		} else {
			const fetched = await guild.channels.fetchActiveThreads();
			threads = [...fetched.threads.values()].filter(
				(t) => !parentId || t.parentId === parentId,
			);
		}
		const sees = (member: GuildMember, thread: AnyThreadChannel) => {
			const permissions = thread.permissionsFor(member);
			return (
				permissions.has(PermissionFlagsBits.ViewChannel) &&
				(thread.type !== ChannelType.PrivateThread ||
					permissions.has(PermissionFlagsBits.ManageThreads))
			);
		};
		return threads.flatMap((t) =>
			sees(owner, t) && sees(bot, t)
				? [
						{
							id: t.id,
							name: t.name,
							parentId: t.parentId,
							private: t.type === ChannelType.PrivateThread,
							archived: t.archived,
							locked: t.locked,
							messageCount: t.messageCount,
							createdAt: t.createdAt?.toISOString() ?? null,
						},
					]
				: [],
		);
	}

	async create(args: Record<string, unknown>) {
		const parent = await fetchManagedChannel(
			this.#client,
			String(args.channelId),
		);
		const isPrivate = args.private === true;
		if (isPrivate && (args.messageId || parent.type !== ChannelType.GuildText))
			throw refuse(
				"INVALID_ARGUMENT",
				"a private thread starts on its own in a text channel",
			);
		await this.#access.members(
			parent.guild,
			[
				PermissionFlagsBits.ViewChannel,
				isPrivate
					? PermissionFlagsBits.CreatePrivateThreads
					: PermissionFlagsBits.CreatePublicThreads,
				PermissionFlagsBits.SendMessagesInThreads,
			],
			parent,
		);
		const options = {
			name: String(args.name),
			...(typeof args.autoArchiveMinutes === "number"
				? { autoArchiveDuration: args.autoArchiveMinutes }
				: {}),
			reason: typeof args.reason === "string" ? args.reason : this.#reason,
		};
		let thread: AnyThreadChannel;
		if (typeof args.messageId === "string") {
			const message = await parent.messages.fetch(args.messageId).catch(() => {
				throw refuse("UNKNOWN_MESSAGE", String(args.messageId));
			});
			thread = await message.startThread(options);
		} else if (isPrivate && parent.type === ChannelType.GuildText) {
			thread = await parent.threads.create({
				...options,
				type: ChannelType.PrivateThread,
			});
			await thread.members.add(this.#ownerId);
		} else {
			thread = await parent.threads.create(options);
		}
		return {
			id: thread.id,
			name: thread.name,
			parentId: thread.parentId,
			private: isPrivate,
		};
	}

	async edit(args: Record<string, unknown>) {
		const thread = await fetchOwnerChannel(this.#client, String(args.threadId));
		if (!thread.isThread())
			throw refuse("INVALID_CHANNEL", "threadId is not a thread");
		await this.#access.members(
			thread.guild,
			[PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageThreads],
			thread,
		);
		await thread.edit({
			...(typeof args.name === "string" ? { name: args.name } : {}),
			...(typeof args.archived === "boolean"
				? { archived: args.archived }
				: {}),
			...(typeof args.locked === "boolean" ? { locked: args.locked } : {}),
			...(typeof args.autoArchiveMinutes === "number"
				? { autoArchiveDuration: args.autoArchiveMinutes }
				: {}),
			reason: typeof args.reason === "string" ? args.reason : this.#reason,
		});
		return {
			id: thread.id,
			name: thread.name,
			archived: thread.archived,
			locked: thread.locked,
		};
	}
}
