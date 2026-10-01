import { type Message, MessageReferenceType } from "discord.js";
import type { InboundMessage } from "../contract/channels.ts";
import { channelKey } from "../contract/surface.ts";
import type { AttachmentRef } from "../domain/attachment.ts";

/** Who the bot is on Discord, as far as the client knows it. */
export interface BotIdentity {
	/** The bot user's id; undefined until the client is ready. */
	botId: string | undefined;
	/** The application's id, which the webhooks the assistant created carry. */
	applicationId: string | undefined;
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

/**
 * The facts of one Discord message, as the neutral `InboundMessage`; undefined for the bot's own
 * messages and before the client is ready. A forward reports the channel it came from as a
 * channel key, and a webhook's post as an integration.
 */
export async function toInbound(
	message: Message,
	{ botId, applicationId }: BotIdentity,
): Promise<InboundMessage | undefined> {
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
		channel: channelKey("discord", message.channelId),
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
					integration: {
						id: message.webhookId,
						// Webhooks the assistant created carry its application on every message they post.
						own:
							message.applicationId !== null &&
							message.applicationId === (applicationId ?? botId),
					},
				}
			: {}),
		isDirect: message.channel.isDMBased(),
		...(message.guildId ? { space: message.guildId } : {}),
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
						source: channelKey("discord", reference.channelId),
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
