import { serviceKey } from "pi-roundtable";
import type { LineContentRequest, LineContentResult } from "./content.ts";
import type { LineSubscriber } from "./messages.ts";
import type { LineSources } from "./sources.ts";

/** What other plugins read from this one, through the `LINE` service key. */
export interface LineBridgePort {
	/** The chats the bot has seen, and the allowlist over them. */
	readonly sources: LineSources;
	/** The bot's user id once LINE has told it, else undefined. */
	botUserId(): string | undefined;
	/** The token source's health: how many tokens were issued and why the last attempt failed, if it did. */
	health(): { tokensIssued: number; tokenFailure: string | undefined };
	/**
	 * Becomes the one consumer of the package: from now on each stored event of an allowed chat (and
	 * the join and leave of any chat) is turned into a typed event and handed to `handler`, oldest
	 * first within a chat, at least once. A second subscriber is refused (the call throws). Returns the
	 * function that detaches this one. With none attached events wait in the inbox, payload and all,
	 * until retention removes them.
	 */
	subscribe(handler: LineSubscriber): () => void;
	/**
	 * The content of a message, held in memory only: `{ bytes, contentType }`, `{ tooLarge }` past
	 * `media.maxBytes`, or `{ expired }` when LINE no longer has it (or the message was unsent).
	 * Pass the event's `kind` so a video or audio is waited for until LINE has transcoded it, and the
	 * handler's signal so the download stops when the event is given up.
	 */
	content(
		messageId: string,
		request?: LineContentRequest,
	): Promise<LineContentResult>;
}

export const LINE = serviceKey<LineBridgePort>("roundtable.line", {
	absent:
		"add the line() plugin from pi-roundtable-line to the host's plugins before the plugin that reads it",
});
