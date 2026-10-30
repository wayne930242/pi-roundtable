import { Routes } from "discord.js";
import type { DiscordMessage, DiscordPoster, RecentMessage } from "./poster.ts";
import { checkSnowflake } from "./poster-checks.ts";
import { DiscordPosterError, failure } from "./poster-errors.ts";
import { type DiscordRest, object, text } from "./rest-poster-core.ts";

/** How many pins Discord lists in a page, and how many pages the poster reads (250 pins, the most a channel keeps). */
const PIN_PAGE = 50;
const PIN_PAGES = 5;

/** The poster's pin calls and the reads of messages. */
export type ReadOperations = Pick<
	DiscordPoster,
	"pin" | "unpin" | "pinnedIds" | "message" | "recentMessages"
>;

export function readOperations(rest: DiscordRest): ReadOperations {
	return {
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
	};
}
