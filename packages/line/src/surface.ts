import {
	type ChannelKey,
	type ChatSurface,
	type InboundMessage,
	type OutboundReply,
	PluginError,
	parseChannelKey,
} from "pi-roundtable";
import { LineError } from "./errors.ts";
import { parseSourceKey } from "./events.ts";
import type { LineOutbox, LineOutMessage } from "./outbox.ts";

/** The longest text one LINE message holds. */
const TEXT_MAX = 5000;

/** `text` cut into pieces LINE takes, never inside a surrogate pair. */
function pieces(text: string): string[] {
	const parts: string[] = [];
	let rest = text;
	while (rest.length > TEXT_MAX) {
		let cut = TEXT_MAX;
		const last = rest.charCodeAt(cut - 1);
		if (last >= 0xd800 && last <= 0xdbff) cut--;
		parts.push(rest.slice(0, cut));
		rest = rest.slice(cut);
	}
	if (rest.trim() !== "") parts.push(rest);
	return parts;
}

/**
 * The chats of LINE as a chat surface, under the prefix `line`: the channel of a chat is its source
 * key, `line:group:<id>`, `line:room:<id>` or `line:user:<id>`. What the host writes in a channel is
 * queued in the outbox as text messages, one per chunk, and goes out as a push; it reaches only a
 * chat on the allowlist. Messages come in only when the plugin routes them (`route: true`), as the
 * text of allowed chats. The surface offers no typing indicator, stop control, progress, files or
 * approval prompts: LINE has none the bot can show, and an approval would have to be answered by
 * the people of the chat.
 */
export class LineSurface implements ChatSurface {
	readonly surface = "line";
	readonly #outbox: LineOutbox;
	#deliver: ((message: InboundMessage) => void) | undefined;

	constructor(outbox: LineOutbox) {
		this.#outbox = outbox;
	}

	async start(deliver: (message: InboundMessage) => void): Promise<void> {
		this.#deliver = deliver;
	}

	async stop(): Promise<void> {
		this.#deliver = undefined;
	}

	/** Hands a message to the host's router; throws until the host has started the surface. */
	deliver(message: InboundMessage): void {
		if (!this.#deliver)
			throw new LineError(
				"surface_not_started",
				"line: the surface has not started; messages are routed once the host runs",
			);
		this.#deliver(message);
	}

	async sendReply(channel: ChannelKey, reply: OutboundReply): Promise<void> {
		const { surface } = parseChannelKey(channel);
		if (surface !== this.surface || !parseSourceKey(channel))
			throw new PluginError(`${channel} is not a LINE chat`);
		const messages: LineOutMessage[] = reply.chunks
			.flatMap(pieces)
			.map((text) => ({ type: "text", text }));
		if (messages.length > 0) await this.#outbox.enqueue(channel, messages);
	}
}
