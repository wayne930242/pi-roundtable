import type { ChannelKey, TurnResult } from "pi-roundtable";
import { type ChatInternals, type Pending, Refusal } from "./chat-types.ts";

/** One turn, after checking again, inside the queue, that the conversation is still the speaker's. */
export async function runChatTurn(
	chat: ChatInternals,
	channel: ChannelKey,
	text: string,
	pending: Pending,
): Promise<void> {
	const { speaker, persona } = pending;
	const conversation = chat.surface.conversationOf(channel);
	let registered = false;
	try {
		registered = (await chat.own(speaker, conversation)).record !== undefined;
	} catch (error) {
		if (!(error instanceof Refusal)) throw error;
		chat.deps.logger.warn(
			{ channel, code: error.code },
			"a web chat message was refused before its turn",
		);
		chat.connections.sendTo(speaker.principalId, {
			type: "error",
			code: error.code,
		});
		return;
	}
	let answered = false;
	try {
		if (!registered) {
			const kept = await chat.deps.registry().register({
				key: channel,
				kind: persona.kind,
				visibility: "private",
				principalId: speaker.principalId,
				...(pending.title ? { title: pending.title } : {}),
			});
			if (
				kept.visibility !== "private" ||
				kept.principalId !== speaker.principalId
			)
				throw new Refusal("forbidden");
		}
		chat.registered.add(channel);
		// What the connection that sent the message can do for the turn's tools, until the turn ends.
		const client = chat.clients.portFor(pending.connection, conversation);
		try {
			await chat.deps.turns().run({
				channel,
				kind: persona.kind,
				text,
				speaker,
				...(pending.origin ? { origin: pending.origin } : {}),
				...(client ? { client } : {}),
				interactive: true,
				byMessage: true,
				...(pending.attachments ? { attachments: pending.attachments } : {}),
				...(persona.selection
					? {
							selection: {
								id: `webchat:${persona.kind}`,
								...persona.selection,
							},
						}
					: {}),
				conversation: {
					visibility: "private",
					...(pending.fresh && pending.title ? { title: pending.title } : {}),
				},
				reply: async (result) => {
					answered = true;
					deliverReply(chat, speaker.principalId, conversation, result);
				},
			});
		} finally {
			client?.end();
		}
	} catch (error) {
		// A turn the host refused before it ran, such as one whose conversation could not be
		// recorded, has no reply: the person is told it failed, and the router logs the cause.
		if (!answered)
			chat.connections.sendTo(speaker.principalId, {
				type: "failed",
				conversation,
				stopped: false,
			});
		throw error;
	}
	// The registry now records it, so the opened-but-unused entry is spent.
	chat.minted.delete(conversation);
}

export function deliverReply(
	chat: ChatInternals,
	principal: string,
	conversation: string,
	result: TurnResult,
): void {
	if (!result.ok) {
		chat.connections.sendTo(principal, {
			type: "failed",
			conversation,
			stopped: result.stopped === true,
		});
		return;
	}
	chat.connections.sendTo(principal, {
		type: "reply",
		conversation,
		text: chat.surface.readable(result.text),
		...(result.thinking ? { thinking: result.thinking } : {}),
		...(result.files?.length
			? {
					files: result.files.map((file) => ({
						name: file.name,
						data: Buffer.from(file.data).toString("base64"),
					})),
				}
			: {}),
	});
}
