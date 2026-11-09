import { type ChannelClaim, PERSONAL_TARGET } from "pi-roundtable";
import { deliverReply, runChatTurn } from "./chat-turn.ts";
import { type ChatInternals, Refusal, type WebPersona } from "./chat-types.ts";

/** The claim of this chat's conversations: only messages this chat accepted run, as their person's turns. */
export function webChatClaim(chat: ChatInternals): ChannelClaim {
	const { surface } = chat.deps;
	return {
		name: `webchat:${surface}`,
		priority: 10,
		postsInPlace: true,
		takesSystemReports: false,
		owns: (channel) => channel.startsWith(`${surface}:`),
		admit: (message) => {
			const pending = chat.pending.get(message.messageId);
			chat.pending.delete(message.messageId);
			const speaker = message.speaker;
			if (
				!pending ||
				pending.speaker.id !== message.authorId ||
				!speaker ||
				speaker.principalId !== pending.speaker.principalId
			) {
				pending?.release();
				if (pending)
					chat.connections.sendTo(pending.speaker.principalId, {
						type: "failed",
						conversation: chat.surface.conversationOf(message.channel),
						stopped: false,
					});
				return undefined;
			}
			return {
				kind: "turn",
				run: async () => {
					try {
						await runChatTurn(chat, message.channel, message.text, {
							...pending,
							speaker,
						});
					} finally {
						pending.release();
					}
				},
				// Dropped by the router after all: the message never runs, so its place is free, and its
				// person, told it was accepted, is told it failed, as for a turn the host refused.
				dropped: () => {
					pending.release();
					chat.connections.sendTo(pending.speaker.principalId, {
						type: "failed",
						conversation: chat.surface.conversationOf(message.channel),
						stopped: false,
					});
				},
				failure: "a web chat turn failed",
			};
		},
		background: async (turn) => {
			if (turn.target !== PERSONAL_TARGET.name)
				return {
					status: "skipped",
					reason: "webchat takes only personal background turns",
				};
			const { speaker } = turn;
			if (!speaker || speaker.principalId !== turn.author.principalId)
				return {
					status: "skipped",
					reason: "webchat needs the router's checked principal",
				};
			const conversation = chat.surface.conversationOf(turn.channel);
			const record = await chat.deps.registry().get(turn.channel);
			if (
				record?.visibility !== "private" ||
				record.principalId !== turn.author.principalId
			)
				return {
					status: "skipped",
					reason:
						"the background author does not own this private conversation",
				};
			let persona: WebPersona;
			try {
				persona = (await chat.own(speaker, conversation)).persona;
			} catch (error) {
				if (!(error instanceof Refusal)) throw error;
				return { status: "skipped", reason: error.code };
			}
			// Background work has already been admitted by core. Its runtime queue is
			// separate from interactive admission: a busy browser must not discard
			// a completed delegation or scheduled reminder. Runtime owns stop/shutdown.
			const result = await chat.deps.turns().run({
				channel: turn.channel,
				kind: persona.kind,
				text: turn.text,
				speaker,
				interactive: turn.report === true,
				unattended: turn.report !== true,
				...(turn.timeLimitMs === undefined
					? {}
					: { timeLimitMs: turn.timeLimitMs }),
				conversation: { visibility: "private" },
				...(persona.selection
					? {
							selection: {
								id: `webchat:${persona.kind}`,
								...persona.selection,
							},
						}
					: {}),
				reply: async (result) =>
					deliverReply(chat, speaker.principalId, conversation, result),
			});
			return result.ok
				? { status: "ran" }
				: { status: "failed", error: "a webchat background turn failed" };
		},
		startFresh: async (channel) => {
			const record = await chat.deps.registry().get(channel);
			if (record?.visibility !== "private" || !record.principalId)
				throw new Refusal("unknown_conversation");
			chat.owners.set(chat.surface.conversationOf(channel), record.principalId);
			chat.registered.add(channel);
			await chat.deps.runtime().startFresh(channel);
			return record.kind;
		},
		stop: (channel) =>
			chat.registered.has(channel) && chat.deps.runtime().stop(channel),
	};
}
