import {
	AttachmentRefusal,
	channelKey,
	type TurnAttachments,
} from "pi-roundtable";
import { type ChatInternals, Refusal, titleOf } from "./chat-types.ts";
import type { Connection } from "./connections.ts";
import { identityActor } from "./oidc.ts";
import type { ClientFrame } from "./protocol.ts";

export async function acceptMessage(
	chat: ChatInternals,
	connection: Connection,
	frame: Extract<ClientFrame, { type: "send" }>,
): Promise<void> {
	const { speaker } = connection;
	const text = frame.text;
	if (!text.trim() || text.length > chat.deps.limits.messageChars)
		throw new Refusal("bad_frame");
	const files = frame.attachments ?? [];
	if (files.length > chat.deps.limits.attachmentsPerMessage)
		throw new Refusal("bad_frame");
	// Checked before a conversation is opened for it, so a refused message opens none.
	if (!chat.turns.allows(speaker.principalId, frame.conversation))
		throw new Refusal("busy");
	const conversation =
		frame.conversation ?? chat.open(speaker, frame.persona as string);
	const { persona, record, minted } = await chat.own(speaker, conversation);
	const release = chat.turns.take(speaker.principalId, conversation);
	if (!release) {
		// Another message took the last place meanwhile.
		if (!frame.conversation) chat.minted.delete(conversation);
		throw new Refusal("busy");
	}
	let attachments: TurnAttachments | undefined;
	if (files.length > 0) {
		try {
			attachments = await chat.deps
				.attachments()
				.turnAttachments(
					channelKey(chat.deps.surface, conversation),
					speaker.principalId,
					files,
					{
						usedBytesLimit: chat.deps.limits.usedAttachmentBytesPerPrincipal,
					},
				);
		} catch (error) {
			// The refused message holds no place and opens no conversation.
			release();
			if (!frame.conversation) chat.minted.delete(conversation);
			if (!(error instanceof AttachmentRefusal)) throw error;
			throw new Refusal(
				error.code === "unknown_file"
					? "unknown_attachment"
					: error.code === "quota_exceeded"
						? "attachment_quota"
						: "forbidden",
			);
		}
	}
	const messageId = crypto.randomUUID();
	chat.pending.set(messageId, {
		speaker,
		connection,
		...(connection.origin ? { origin: connection.origin } : {}),
		persona,
		title: minted?.title ?? titleOf(text),
		fresh: record === undefined,
		...(attachments ? { attachments } : {}),
		release,
	});
	chat.connections.send(connection, {
		type: "accepted",
		id: frame.id,
		conversation,
	});
	try {
		chat.surface.deliver({
			channel: channelKey(chat.deps.surface, conversation),
			messageId,
			actor: identityActor(connection.identity, chat.deps.surface),
			authorId: speaker.id,
			authorName: speaker.name,
			authorIsBot: false,
			authorRoleIds: connection.identity.roles,
			isDirect: true,
			mentionsBot: false,
			repliesToBot: false,
			text,
			attachments: [],
		});
	} catch (error) {
		chat.pending.delete(messageId);
		release();
		throw error;
	}
}
