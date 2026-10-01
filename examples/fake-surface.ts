import {
	type ChannelKey,
	type ChatSurface,
	definePlugin,
	type InboundMessage,
	type OutboundReply,
	type OwnerPrompts,
	parseChannelKey,
} from "pi-roundtable";

/**
 * A chat surface connects the host to one chat network. This one is an in-memory chat: its
 * channels are the keys that start with `fake:`, and it records what the host asks of it. A real
 * surface talks to its network in `start` and `sendReply`, and skips the optional methods it
 * cannot do.
 */
export class FakeSurface implements ChatSurface {
	readonly surface = "fake";
	readonly replies: { channel: ChannelKey; reply: OutboundReply }[] = [];
	readonly typing: string[] = [];
	readonly stops: string[] = [];
	readonly asked: string[] = [];
	#deliver: ((message: InboundMessage) => void) | undefined;

	/** The host hands over its router; every message the network reports goes to it. */
	async start(deliver: (message: InboundMessage) => void): Promise<void> {
		this.#deliver = deliver;
	}

	async stop(): Promise<void> {
		this.#deliver = undefined;
	}

	/** Someone writes in a channel. */
	say(channel: ChannelKey, text: string): void {
		this.#deliver?.({
			channel,
			messageId: `m${this.replies.length}`,
			authorId: "1",
			authorName: "Ada",
			authorIsBot: false,
			isDirect: true,
			mentionsBot: false,
			repliesToBot: false,
			text,
			attachments: [],
		});
	}

	async sendReply(channel: ChannelKey, reply: OutboundReply): Promise<void> {
		this.replies.push({ channel, reply });
	}

	startTyping(channel: ChannelKey): () => void {
		this.typing.push(`start ${channel}`);
		return () => void this.typing.push(`stop ${channel}`);
	}

	showStop(channel: ChannelKey): () => void {
		this.stops.push(`show ${channel}`);
		return () => void this.stops.push(`hide ${channel}`);
	}

	/** How the owner would approve a held action or answer a question in a turn. */
	prompts(channel: ChannelKey): OwnerPrompts {
		return {
			confirm: async (title) => {
				this.asked.push(`${channel}: ${title}`);
				return "approved";
			},
			ask: async () => undefined,
		};
	}
}

/**
 * The plugin contributes the surface, and a claim that owns the channels of its prefix and
 * answers through `context.surfaces`, which picks the surface by the prefix of the channel's key.
 */
export function fakeChat(surface: FakeSurface) {
	return definePlugin({
		name: "fake-chat",
		setup: ({ surfaces }) => ({
			surfaces: [surface],
			channels: [
				{
					name: "fake-channels",
					priority: 10,
					owns: (channel) => parseChannelKey(channel).surface === "fake",
					admit: (message) => ({
						kind: "turn",
						run: async () => {
							const stopTyping = surfaces.startTyping(message.channel);
							try {
								await surfaces.sendReply(message.channel, {
									chunks: [`echo: ${message.text}`],
								});
							} finally {
								stopTyping();
							}
						},
						failure: "a fake chat turn failed",
					}),
					startFresh: async () => "The fake chat has nothing to start over.",
				},
			],
		}),
	});
}
