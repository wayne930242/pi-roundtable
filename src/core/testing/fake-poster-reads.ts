import {
	DISCORD_LIMITS,
	type DiscordMessage,
	type RecentMessage,
} from "../discord/poster/poster.ts";
import { checkSnowflake } from "../discord/poster/poster-checks.ts";
import { DiscordPosterError } from "../discord/poster/poster-errors.ts";
import { FakePosterGuild } from "./fake-poster-guild.ts";

/** The fake's pin calls and message reads, on top of its channel, thread and member calls. */
export abstract class FakePosterReads extends FakePosterGuild {
	async pin(channelId: string, messageId: string): Promise<void> {
		checkSnowflake("a channel", channelId);
		checkSnowflake("a message", messageId);
		this.sent("pin");
		const channel = this.channel(channelId);
		this.found(channelId, messageId);
		if (channel.pins.includes(messageId)) return;
		if (channel.pins.length >= DISCORD_LIMITS.pins)
			throw new DiscordPosterError(
				"rejected",
				`a channel keeps at most ${DISCORD_LIMITS.pins} pins`,
				{ discordCode: 30003, status: 400 },
			);
		channel.pins.push(messageId);
		if (this.pinNotices) {
			this.next += 1n;
			channel.messages.push({
				id: this.next.toString(),
				username: "bot",
				content: "",
				files: [],
				blobs: [],
				mentions: [],
				authorId: this.botId,
				type: 6,
				referencedMessageId: messageId,
				at: this.tick(),
			});
		}
	}

	async unpin(channelId: string, messageId: string): Promise<void> {
		checkSnowflake("a channel", channelId);
		checkSnowflake("a message", messageId);
		this.sent("unpin");
		const channel = this.channel(channelId);
		channel.pins = channel.pins.filter((id) => id !== messageId);
	}

	async pinnedIds(channelId: string): Promise<string[]> {
		checkSnowflake("a channel", channelId);
		this.sent("pinnedIds");
		return [...this.channel(channelId).pins].reverse();
	}

	async message(channelId: string, messageId: string): Promise<DiscordMessage> {
		checkSnowflake("a channel", channelId);
		checkSnowflake("a message", messageId);
		this.sent("message");
		const found = this.found(channelId, messageId);
		return {
			id: found.id,
			authorId: found.webhookId ?? found.authorId ?? "0",
			...(found.webhookId ? { webhookId: found.webhookId } : {}),
			content: found.content,
			files: found.files.map((file, index) => ({
				name: file.name,
				contentType: found.blobs[index]?.contentType ?? "",
				size: file.bytes,
				url:
					found.urls?.[index] ??
					`https://cdn.test/${found.id}/${encodeURIComponent(file.name)}`,
			})),
		};
	}

	async recentMessages(
		channelId: string,
		limit: number,
	): Promise<RecentMessage[]> {
		checkSnowflake("a channel", channelId);
		this.sent("recentMessages");
		return [...this.channel(channelId).messages]
			.reverse()
			.slice(0, Math.min(50, Math.max(1, Math.trunc(limit))))
			.map((message) => ({
				id: message.id,
				type: message.type ?? 0,
				authorId: message.webhookId ?? message.authorId ?? "0",
				...(message.referencedMessageId
					? { referencedMessageId: message.referencedMessageId }
					: {}),
			}));
	}
}
