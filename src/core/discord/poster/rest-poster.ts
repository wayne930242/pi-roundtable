import { RESTJSONErrorCodes, Routes } from "discord.js";
import type {
	DiscordMessage,
	DiscordPoster,
	PosterFile,
	RecentMessage,
} from "./poster.ts";
import {
	cardBody,
	checkAvatar,
	checkedPost,
	checkedText,
	checkSnowflake,
	checkWebhookName,
	invalid,
} from "./poster-checks.ts";
import { DiscordPosterError, failure, isCode } from "./poster-errors.ts";
import {
	type DiscordRest,
	object,
	restCore,
	text,
} from "./rest-poster-core.ts";
import { guildOperations } from "./rest-poster-guild.ts";

export type { DiscordRest, RestOptions } from "./rest-poster-core.ts";
export { restOf } from "./rest-poster-core.ts";

/** How many pins Discord lists in a page, and how many pages the poster reads (250 pins, the most a channel keeps). */
const PIN_PAGE = 50;
const PIN_PAGES = 5;

interface Webhook {
	id: string;
	token: string;
}

/** The files as the REST client sends them. */
function rawFiles(files: readonly PosterFile[]) {
	return files.map((file) => ({
		name: file.name,
		data: file.data,
		...(file.contentType ? { contentType: file.contentType } : {}),
	}));
}

function messageIdOf(sent: unknown): string {
	const messageId = text(object(sent).id);
	if (!messageId)
		throw new DiscordPosterError("rejected", "Discord returned no message");
	return messageId;
}

/**
 * The poster over Discord's REST API. A webhook is found by name among the ones the bot made in the
 * channel, or made, the first time the channel is used under that name. Their ids and tokens are
 * held in this process's memory only and are never logged, put in an error or kept on disk.
 */
export function restPoster(
	rest: DiscordRest,
	options: { renameWaitMs?: number } = {},
): DiscordPoster {
	const core = restCore(rest);
	// Held in the closure so that printing or serializing the poster shows no token.
	const webhooks = new Map<string, Webhook>();
	const finding = new Map<string, Promise<Webhook | undefined>>();
	const madeListeners = new Set<
		(channelId: string, webhook: string) => Promise<void>
	>();

	/** The channel's webhooks the bot made. */
	const listMine = async (
		channelId: string,
	): Promise<Record<string, unknown>[]> => {
		const listed = await rest
			.get(Routes.channelWebhooks(channelId))
			.catch((error: unknown) => {
				throw failure("listing the channel's webhooks", error);
			});
		const mine = await core.bot();
		return (Array.isArray(listed) ? listed : [])
			.map(object)
			.filter((hook) => object(hook.user).id === mine);
	};

	/** The channel's webhook of that name; made when there is none, unless `make` is false (then undefined). */
	const find = async (
		channelId: string,
		name: string,
		make: boolean,
	): Promise<Webhook | undefined> => {
		for (const hook of await listMine(channelId)) {
			const id = text(hook.id);
			const token = text(hook.token);
			if (hook.name === name && id && token) return { id, token };
		}
		if (!make) return undefined;
		const made = object(
			await rest
				.post(Routes.channelWebhooks(channelId), { body: { name } })
				.catch((error: unknown) => {
					throw failure("making the channel's webhook", error);
				}),
		);
		const id = text(made.id);
		const token = text(made.token);
		if (!id || !token)
			throw new DiscordPosterError(
				"rejected",
				"Discord made no usable webhook",
			);
		// The new webhook has the default picture; whoever kept an avatar for the channel forgets it
		// before the webhook is used, so a late record cannot outlive the picture it describes.
		for (const listener of madeListeners)
			await listener(channelId, name).catch(() => undefined);
		return { id, token };
	};

	const webhook = (
		channelId: string,
		name: string,
		make: boolean,
	): Promise<Webhook | undefined> => {
		const slot = `${channelId}:${name}`;
		const known = webhooks.get(slot);
		if (known) return Promise.resolve(known);
		// A look that may not make the webhook answers `undefined` for a channel that has none, which
		// a call that needs one must not share: the two are different questions.
		const search = `${slot}:${make ? "make" : "find"}`;
		let pending = finding.get(search);
		if (!pending) {
			pending = find(channelId, name, make)
				.then((found) => {
					if (found) webhooks.set(slot, found);
					return found;
				})
				.finally(() => finding.delete(search));
			finding.set(search, pending);
		}
		return pending;
	};

	/** Runs a call through the channel's webhook; a webhook deleted meanwhile is found or made again once. */
	const through = async <T>(
		operation: string,
		channelId: string,
		name: string,
		call: (hook: Webhook) => Promise<T>,
		make: boolean,
	): Promise<T | undefined> => {
		for (let attempt = 0; ; attempt++) {
			const hook = await webhook(channelId, name, make);
			// Only a call that may not make the webhook gets here without one.
			if (!hook) return undefined;
			try {
				return await call(hook);
			} catch (error) {
				if (
					attempt === 0 &&
					isCode(
						error,
						RESTJSONErrorCodes.UnknownWebhook,
						RESTJSONErrorCodes.InvalidWebhookToken,
					)
				) {
					webhooks.delete(`${channelId}:${name}`);
					continue;
				}
				throw failure(operation, error);
			}
		}
	};

	/** Asks each named webhook in turn to act on a message; the first that does it ends the search, and `message_gone` is what is left when none could. */
	const eachWebhook = async (
		operation: string,
		channelId: string,
		names: readonly string[],
		call: (hook: Webhook) => Promise<unknown>,
	): Promise<void> => {
		let gone: DiscordPosterError | undefined;
		for (const name of names) {
			try {
				const done = await through(
					operation,
					channelId,
					name,
					(hook) => call(hook).then(() => true),
					false,
				);
				if (done) return;
			} catch (error) {
				if (
					!(error instanceof DiscordPosterError) ||
					error.kind !== "message_gone"
				)
					throw error;
				gone = error;
			}
		}
		throw (
			gone ??
			new DiscordPosterError("message_gone", "the message does not exist")
		);
	};

	const guild = guildOperations(core, options);

	return {
		...guild,
		async post(channelId, post) {
			checkSnowflake("a channel", channelId);
			const { webhook: name, body, files } = checkedPost(post);
			const sent = await through(
				"posting a message",
				channelId,
				name,
				(hook) =>
					rest.post(Routes.webhook(hook.id, hook.token), {
						auth: false,
						body,
						query: new URLSearchParams({ wait: "true" }),
						...(files.length > 0 ? { files: rawFiles(files) } : {}),
					}),
				true,
			);
			return { channelId, messageId: messageIdOf(sent) };
		},
		async edit(channelId, messageId, edit, names) {
			checkSnowflake("a channel", channelId);
			checkSnowflake("a message", messageId);
			const body = checkedText(edit.content, edit.mentions);
			for (const name of names) checkWebhookName(name);
			// A webhook edits only its own messages, and the caller may not know whose this is.
			await eachWebhook("editing a message", channelId, names, (hook) =>
				rest.patch(Routes.webhookMessage(hook.id, hook.token, messageId), {
					auth: false,
					body,
				}),
			);
		},
		async remove(channelId, messageId, names) {
			checkSnowflake("a channel", channelId);
			checkSnowflake("a message", messageId);
			for (const name of names) checkWebhookName(name);
			try {
				await eachWebhook("deleting a message", channelId, names, (hook) =>
					rest.delete(Routes.webhookMessage(hook.id, hook.token, messageId), {
						auth: false,
					}),
				);
			} catch (error) {
				if (
					!(error instanceof DiscordPosterError) ||
					error.kind !== "message_gone"
				)
					throw error;
				// A webhook deletes only its own messages. One an earlier webhook of the same name posted
				// (the webhook was deleted and made again) is the bot's to delete, with Manage Messages;
				// when it is gone for real, Discord says so here too.
				await rest
					.delete(Routes.channelMessage(channelId, messageId))
					.catch((second: unknown) => {
						const failed = failure("deleting a message as the bot", second);
						throw failed.kind === "message_gone" ? error : failed;
					});
			}
		},
		async webhookIds(channelId, names) {
			checkSnowflake("a channel", channelId);
			for (const name of names) checkWebhookName(name);
			const ids: Record<string, string[]> = {};
			for (const name of names) ids[name] = [];
			for (const hook of await listMine(channelId)) {
				const id = text(hook.id);
				const list = typeof hook.name === "string" ? ids[hook.name] : undefined;
				if (id && list) list.push(id);
			}
			return ids;
		},
		async setAvatar(channelId, name, png) {
			checkSnowflake("a channel", channelId);
			checkWebhookName(name);
			checkAvatar(png);
			const avatar = `data:image/png;base64,${Buffer.from(png).toString("base64")}`;
			await through(
				"setting the webhook's avatar",
				channelId,
				name,
				(hook) =>
					rest.patch(Routes.webhook(hook.id, hook.token), {
						auth: false,
						body: { avatar },
					}),
				true,
			);
		},
		onWebhookMade(listener) {
			madeListeners.add(listener);
			return () => void madeListeners.delete(listener);
		},
		async say(channelId, post) {
			checkSnowflake("a channel", channelId);
			if (!post.content) throw invalid("a message needs text");
			const body = checkedText(post.content, post.mentions);
			const sent = await rest
				.post(Routes.channelMessages(channelId), { body })
				.catch((error: unknown) => {
					throw failure("posting as the bot", error);
				});
			return { channelId, messageId: messageIdOf(sent) };
		},
		async sayCard(channelId, card) {
			checkSnowflake("a channel", channelId);
			const sent = await rest
				.post(Routes.channelMessages(channelId), { body: cardBody(card) })
				.catch((error: unknown) => {
					throw failure("posting a card as the bot", error);
				});
			return { channelId, messageId: messageIdOf(sent) };
		},
		async editCard(channelId, messageId, card) {
			checkSnowflake("a channel", channelId);
			checkSnowflake("a message", messageId);
			await rest
				.patch(Routes.channelMessage(channelId, messageId), {
					body: cardBody(card),
				})
				.catch((error: unknown) => {
					throw failure("editing a card", error);
				});
		},
		async deleteAsBot(channelId, messageId) {
			checkSnowflake("a channel", channelId);
			checkSnowflake("a message", messageId);
			await rest
				.delete(Routes.channelMessage(channelId, messageId))
				.catch((error: unknown) => {
					throw failure("deleting a message as the bot", error);
				});
		},
		async sendDirect(userId, content) {
			checkSnowflake("a user", userId);
			const body = checkedText(content, []);
			try {
				const channel = object(
					await rest.post(Routes.userChannels(), {
						body: { recipient_id: userId },
					}),
				);
				const id = text(channel.id);
				if (!id)
					throw new DiscordPosterError("rejected", "Discord opened no channel");
				await rest.post(Routes.channelMessages(id), { body });
				return "sent";
			} catch (error) {
				// The person takes no direct messages from this bot: an answer, not a failure.
				if (isCode(error, RESTJSONErrorCodes.CannotSendMessagesToThisUser))
					return "closed";
				throw failure("sending a direct message", error);
			}
		},
		async pin(channelId, messageId) {
			checkSnowflake("a channel", channelId);
			checkSnowflake("a message", messageId);
			await rest
				.put(Routes.channelMessagesPin(channelId, messageId))
				.catch((error: unknown) => {
					throw failure("pinning a message", error);
				});
		},
		async unpin(channelId, messageId) {
			checkSnowflake("a channel", channelId);
			checkSnowflake("a message", messageId);
			await rest
				.delete(Routes.channelMessagesPin(channelId, messageId))
				.catch((error: unknown) => {
					throw failure("unpinning a message", error);
				});
		},
		async pinnedIds(channelId) {
			checkSnowflake("a channel", channelId);
			// Discord keeps at most 250 pins in a channel and lists 50 a page, newest first; `before`
			// takes the `pinned_at` of the last one read. Five pages cover a channel.
			const ids: string[] = [];
			let before: string | undefined;
			for (let page = 0; page < PIN_PAGES; page += 1) {
				const query = new URLSearchParams({ limit: String(PIN_PAGE) });
				if (before) query.set("before", before);
				const listed = object(
					await rest
						.get(Routes.channelMessagesPins(channelId), { query })
						.catch((error: unknown) => {
							throw failure("listing a channel's pins", error);
						}),
				);
				const items = Array.isArray(listed.items) ? listed.items : [];
				for (const entry of items) {
					const id = text(object(object(entry).message).id);
					if (id) ids.push(id);
				}
				const last = text(object(items.at(-1)).pinned_at);
				if (listed.has_more !== true || !last) break;
				before = last;
			}
			return ids;
		},
		async message(channelId, messageId): Promise<DiscordMessage> {
			checkSnowflake("a channel", channelId);
			checkSnowflake("a message", messageId);
			const read = object(
				await rest
					.get(Routes.channelMessage(channelId, messageId))
					.catch((error: unknown) => {
						throw failure("reading a message", error);
					}),
			);
			const id = text(read.id);
			if (!id)
				throw new DiscordPosterError("rejected", "Discord sent no message");
			const webhookId = text(read.webhook_id);
			const files = (
				Array.isArray(read.attachments) ? read.attachments : []
			).flatMap((entry) => {
				const file = object(entry);
				const name = text(file.filename);
				const url = text(file.url);
				return name && url
					? [
							{
								name,
								url,
								contentType: text(file.content_type) ?? "",
								size: typeof file.size === "number" ? file.size : 0,
							},
						]
					: [];
			});
			return {
				id,
				authorId: text(object(read.author).id) ?? "",
				...(webhookId ? { webhookId } : {}),
				content: typeof read.content === "string" ? read.content : "",
				files,
			};
		},
		async recentMessages(channelId, limit): Promise<RecentMessage[]> {
			checkSnowflake("a channel", channelId);
			const listed = await rest
				.get(Routes.channelMessages(channelId), {
					query: new URLSearchParams({
						limit: String(Math.min(50, Math.max(1, Math.trunc(limit)))),
					}),
				})
				.catch((error: unknown) => {
					throw failure("listing a channel's messages", error);
				});
			return (Array.isArray(listed) ? listed : []).flatMap((entry) => {
				const message = object(entry);
				const id = text(message.id);
				if (!id) return [];
				const referenced = text(object(message.message_reference).message_id);
				return [
					{
						id,
						type: typeof message.type === "number" ? message.type : 0,
						authorId: text(object(message.author).id) ?? "",
						...(referenced ? { referencedMessageId: referenced } : {}),
					},
				];
			});
		},
		botUserId: () => core.bot(),
	};
}
