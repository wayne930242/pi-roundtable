import type { ChatSurface } from "../contract/surface.ts";
import type { OutboundReply, PostAuthor } from "../domain/conversation.ts";
import type { InterimPosts } from "../domain/interim.ts";
import type { ChannelKey } from "../domain/sessions.ts";
import type { PlaceSeen } from "./place-contract.ts";

/** A reply the fake room surface was asked to deliver. */
export interface RoomReply {
	channel: ChannelKey;
	reply: OutboundReply;
}

/**
 * A chat surface that hosts agent rooms and shows what it is asked to: replies by `sendReply`
 * under the reply's author, and interim posts edited in place.
 */
export class FakeRoomSurface implements ChatSurface {
	readonly agentRooms = true;
	readonly supportsFiles = true;
	readonly replies: RoomReply[] = [];
	readonly #shown = new Map<ChannelKey, { author: string; text: string }[]>();

	constructor(readonly surface = "app") {}

	async start(): Promise<void> {}

	async sendReply(channel: ChannelKey, reply: OutboundReply): Promise<void> {
		this.replies.push({ channel, reply });
		const author = reply.author?.name ?? "assistant";
		if (reply.thinking) this.#show(channel, author, reply.thinking);
		for (const chunk of reply.chunks) this.#show(channel, author, chunk);
	}

	interim(channel: ChannelKey, as?: PostAuthor): InterimPosts {
		return {
			post: async (text) => {
				const message = this.#show(channel, as?.name ?? "assistant", text);
				return {
					edit: async (change) => {
						message.text = change;
					},
				};
			},
		};
	}

	/** What a person in the room has seen. */
	seen(channel: ChannelKey): readonly PlaceSeen[] {
		return (this.#shown.get(channel) ?? []).map(({ author, text }) => ({
			author,
			text,
		}));
	}

	#show(channel: ChannelKey, author: string, text: string) {
		const message = { author, text };
		this.#shown.set(channel, [...(this.#shown.get(channel) ?? []), message]);
		return message;
	}
}
