import { type Message, MessageReferenceType } from "discord.js";
import type { InboundMessage } from "../contract/channels.ts";
import { channelKey } from "../contract/surface.ts";
import type { AttachmentRef } from "../domain/attachment.ts";
import type { LateTurn } from "./owner-cards.ts";

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

function referenceOf(referenced: Message, mention: RegExp) {
	return {
		text: referenced.content.replace(mention, "").trim(),
		attachments: attachmentRefs(referenced),
		...(referenced.webhookId
			? { webhookName: referenced.author.username }
			: {}),
	};
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
	// botId is the bot's own Discord user id from the client, a snowflake, not message text.
	// nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
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
	const authorName =
		message.member?.displayName ??
		message.author.globalName ??
		message.author.username;
	const roleIds = message.member
		? [...message.member.roles.cache.keys()]
		: undefined;
	return {
		channel: channelKey("discord", message.channelId),
		messageId: message.id,
		// A DM has no member, so its author's roles are unknown, not none.
		actor: {
			provider: "discord",
			subject: message.author.id,
			name: authorName,
			surface: "discord",
			...(roleIds
				? { roles: roleIds.map((role) => `discord:role:${role}`) }
				: {}),
			...(message.guildId ? { space: message.guildId } : {}),
			legacyId: message.author.id,
		},
		authorId: message.author.id,
		authorName,
		authorIsBot: message.author.bot,
		...(roleIds ? { authorRoleIds: roleIds } : {}),
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
		...(referenced ? { reference: referenceOf(referenced, mention) } : {}),
	};
}

/**
 * A card's late answer as a message from whoever answered, in the card's channel, standing in
 * for the card's message: the router resolves its author as any other's, and the claim answers it.
 */
export function lateAnswerMessage(turn: LateTurn): InboundMessage {
	const { user } = turn;
	const roles = user.roleIds;
	return {
		channel: channelKey("discord", turn.channelId),
		messageId: turn.messageId,
		actor: {
			provider: "discord",
			subject: user.id,
			name: user.name,
			surface: "discord",
			...(roles ? { roles: roles.map((role) => `discord:role:${role}`) } : {}),
			...(turn.guildId ? { space: turn.guildId } : {}),
			legacyId: user.id,
		},
		authorId: user.id,
		authorName: user.name,
		authorIsBot: false,
		...(roles ? { authorRoleIds: roles } : {}),
		...(turn.guildId ? { space: turn.guildId } : {}),
		isDirect: turn.isDirect,
		// Pressing the assistant's card speaks to it, as a mention does.
		mentionsBot: true,
		repliesToBot: true,
		text: turn.text,
		attachments: [],
	};
}
