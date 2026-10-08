import {
	type ChannelKey,
	type ChatSurface,
	type InboundMessage,
	type OutboundReply,
	PluginError,
	type PromptScope,
	type Prompts,
	parseChannelKey,
	type TurnProgress,
} from "pi-roundtable";
import type { PromptDesk } from "./prompts.ts";
import type { ServerFrame } from "./protocol.ts";

export interface WebSurfaceOptions {
	/** The key prefix of the conversations, such as "web". */
	surface: string;
	/** Whose a conversation is, by its id; undefined while the process has not seen it. */
	principalOf(conversation: string): string | undefined;
	/** Sends a frame to every connection of a person. */
	send(principal: string, frame: ServerFrame): void;
	prompts: PromptDesk;
}

/**
 * The web conversations as a chat surface: what the host shows in a conversation goes to every
 * open connection of its person, as JSON frames. A reply is sent whole, in markdown, with its
 * files inline.
 */
export class WebSurface implements ChatSurface {
	readonly surface: string;
	readonly supportsFiles = true;
	readonly #options: WebSurfaceOptions;
	#deliver: ((message: InboundMessage) => void) | undefined;

	constructor(options: WebSurfaceOptions) {
		this.surface = options.surface;
		this.#options = options;
	}

	async start(deliver: (message: InboundMessage) => void): Promise<void> {
		this.#deliver = deliver;
	}

	async stop(): Promise<void> {
		this.#deliver = undefined;
	}

	/** Hands a person's message to the host; throws before the host started the surface. */
	deliver(message: InboundMessage): void {
		if (!this.#deliver)
			throw new PluginError(
				"the web chat surface has not started; messages are taken once the host runs",
			);
		this.#deliver(message);
	}

	/** The conversation id of a channel this surface serves. */
	conversationOf(channel: ChannelKey): string {
		const { surface, id } = parseChannelKey(channel);
		if (surface !== this.surface)
			throw new PluginError(`${channel} is not a ${this.surface} conversation`);
		return id;
	}

	#to(channel: ChannelKey): { principal: string; conversation: string } {
		const conversation = this.conversationOf(channel);
		const principal = this.#options.principalOf(conversation);
		if (!principal)
			throw new PluginError(
				`no one is known to own ${channel}; a web conversation is known once its person writes in it`,
			);
		return { principal, conversation };
	}

	async sendReply(channel: ChannelKey, reply: OutboundReply): Promise<void> {
		const { principal, conversation } = this.#to(channel);
		this.#options.send(principal, {
			type: "reply",
			conversation,
			text: reply.chunks.join("\n"),
			...(reply.thinking ? { thinking: reply.thinking } : {}),
			...(reply.files?.length
				? {
						files: reply.files.map((file) => ({
							name: file.name,
							data: Buffer.from(file.data).toString("base64"),
						})),
					}
				: {}),
		});
	}

	/** A pair of frames: `on` now, and the returned function sends `off` once. */
	#toggle(channel: ChannelKey, type: "typing" | "stoppable"): () => void {
		const { principal, conversation } = this.#to(channel);
		this.#options.send(principal, { type, conversation, on: true });
		let on = true;
		return () => {
			if (!on) return;
			on = false;
			this.#options.send(principal, { type, conversation, on: false });
		};
	}

	startTyping(channel: ChannelKey): () => void {
		return this.#toggle(channel, "typing");
	}

	showStop(channel: ChannelKey): () => void {
		return this.#toggle(channel, "stoppable");
	}

	/**
	 * Prompts for the conversation's own person only; a turn for anyone else asks nothing here.
	 * Its owners are not on the web chat, so a prompt above the person's tier goes to no one,
	 * whatever the scope escalates to.
	 */
	prompts(channel: ChannelKey, scope?: PromptScope): Prompts | undefined {
		if (!scope) return undefined;
		const { principal, conversation } = this.#to(channel);
		if (scope.speakerId !== principal) return undefined;
		return this.#options.prompts.prompts(conversation, scope);
	}

	progress(channel: ChannelKey, event: TurnProgress): void {
		const { principal, conversation } = this.#to(channel);
		this.#options.send(principal, { type: "progress", conversation, event });
	}
}
