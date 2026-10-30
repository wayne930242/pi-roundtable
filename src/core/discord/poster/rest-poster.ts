import { RESTJSONErrorCodes, Routes } from "discord.js";
import type { DiscordPoster, PosterFile } from "./poster.ts";
import {
	cardBody,
	checkAvatar,
	checkedPost,
	checkedText,
	checkedWebhookCard,
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
import { readOperations } from "./rest-poster-read.ts";

export type { DiscordRest, RestOptions } from "./rest-poster-core.ts";
export { restOf } from "./rest-poster-core.ts";

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
		release: () => void,
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
		// The webhook is kept, and the look released, before the listeners run: one that posts through
		// it (or sets its picture) finds it instead of waiting on this very look, and a listener that
		// never returns holds only the call that made the webhook, not later looks for it. Concurrent
		// calls may use the new webhook before the listeners finish.
		const fresh = { id, token };
		webhooks.set(`${channelId}:${name}`, fresh);
		release();
		for (const listener of madeListeners)
			await listener(channelId, name).catch(() => undefined);
		return fresh;
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
			const release = () => {
				if (finding.get(search) === pending) finding.delete(search);
			};
			pending = find(channelId, name, make, release)
				.then((found) => {
					// A made webhook is already kept; one made again while its listeners ran must not be replaced
					// by this older one.
					if (found && !webhooks.has(slot)) webhooks.set(slot, found);
					return found;
				})
				.finally(release);
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
		async postCard(channelId, post) {
			checkSnowflake("a channel", channelId);
			const { webhook: name, body } = checkedWebhookCard(post);
			const sent = await through(
				"posting a card",
				channelId,
				name,
				(hook) =>
					rest.post(Routes.webhook(hook.id, hook.token), {
						auth: false,
						body,
						// Without this Discord drops the components of a webhook's post.
						query: new URLSearchParams({
							wait: "true",
							with_components: "true",
						}),
					}),
				true,
			);
			return { channelId, messageId: messageIdOf(sent) };
		},
		async editWebhookCard(channelId, messageId, card, names) {
			checkSnowflake("a channel", channelId);
			checkSnowflake("a message", messageId);
			const body = cardBody(card);
			for (const name of names) checkWebhookName(name);
			await eachWebhook("editing a card", channelId, names, (hook) =>
				rest.patch(Routes.webhookMessage(hook.id, hook.token, messageId), {
					auth: false,
					body,
					query: new URLSearchParams({ with_components: "true" }),
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
			const ids: Record<string, string[]> = Object.create(null);
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
		...readOperations(rest),
		botUserId: () => core.bot(),
	};
}
