import {
	type Approval,
	type ChannelKey,
	type ChatSurface,
	definePlugin,
	type InboundMessage,
	type OutboundReply,
	type PromptScope,
	type Prompts,
	parseChannelKey,
	TIERS,
} from "pi-roundtable";

/** A prompt the surface showed, open until someone it is for answers it. */
interface Asked {
	id: string;
	channel: ChannelKey;
	title: string;
	open: boolean;
}

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
	readonly asked: Asked[] = [];
	/** Who may answer each open prompt, and how it settles. */
	readonly #answering = new Map<
		string,
		{ principalId?: string; owners: boolean; settle(answer: Approval): void }
	>();
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

	/**
	 * How a turn asks to approve a held action or answers a question. The scope names who may
	 * answer: its speaker when their tier holds the call, and the owners unless the conversation
	 * is private, where a call above the speaker's tier goes to no one and expires at once.
	 */
	prompts(channel: ChannelKey, scope?: PromptScope): Prompts {
		return {
			confirm: async (title, _message, signal, minTier = "owner") => {
				const theirs =
					scope !== undefined &&
					TIERS.indexOf(scope.tier) >= TIERS.indexOf(minTier);
				const owners = scope?.escalate !== "none";
				if (!theirs && !owners) return "expired";
				return this.#ask(channel, title, signal, {
					...(theirs ? { principalId: scope.principalId } : {}),
					owners,
				});
			},
			ask: async () => undefined,
		};
	}

	/** Someone answers an open prompt; it settles only when it is theirs to answer. */
	answer(
		id: string,
		who: { principalId: string; owner?: boolean },
		approved: boolean,
	): void {
		const open = this.#answering.get(id);
		if (!open) return;
		const theirs = open.principalId === who.principalId;
		if (theirs || (who.owner && open.owners))
			open.settle(approved ? "approved" : "declined");
	}

	#ask(
		channel: ChannelKey,
		title: string,
		signal: AbortSignal | undefined,
		audience: { principalId?: string; owners: boolean },
	): Promise<Approval> {
		const asked = {
			id: `q${this.asked.length + 1}`,
			channel,
			title,
			open: true,
		};
		this.asked.push(asked);
		return new Promise((resolve) => {
			const settle = (answer: Approval) => {
				this.#answering.delete(asked.id);
				asked.open = false;
				resolve(answer);
			};
			this.#answering.set(asked.id, { ...audience, settle });
			signal?.addEventListener("abort", () => settle("cancelled"), {
				once: true,
			});
		});
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
