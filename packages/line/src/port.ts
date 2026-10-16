import { serviceKey } from "pi-roundtable";
import type { LineApiPort } from "./api-port.ts";
import type { LineContentRequest, LineContentResult } from "./content.ts";
import type { LineSubscriber } from "./messages.ts";
import type { LineOutbox } from "./outbox.ts";
import type { LineScreen } from "./screen.ts";
import type { LineSources } from "./sources.ts";
import type { WebhookHealth } from "./webhook.ts";

/** What other plugins read from this one, through the `LINE` service key. */
export interface LineBridgePort {
	/** The chats the bot has seen, and the allowlist over them. */
	readonly sources: LineSources;
	/** Pushes to the chats on the allowlist, with a sender, a retry key and the quota gate. */
	readonly outbox: LineOutbox;
	/** The bot's user id once LINE has told it, else undefined. */
	botUserId(): string | undefined;
	/**
	 * The plugin's health: how many tokens were issued and why the last attempt failed, if it did, and
	 * what the webhook has answered since the plugin was set up (`webhooks`: counts and times only,
	 * never a body, an address or a signature).
	 */
	health(): {
		tokensIssued: number;
		tokenFailure: string | undefined;
		webhooks: WebhookHealth;
	};
	/**
	 * Becomes the one consumer of the package: from now on each stored event of an allowed chat, the
	 * `join` and `leave` of any chat that is not blocked, and an `unsend` stored while its chat was
	 * allowed (also after the bot has left it, so a mirror is still taken down), is turned into a typed
	 * event and handed to `handler`, oldest first within a chat, at least once. A second subscriber is
	 * refused (the call throws). Returns the function that detaches this one. With none attached
	 * events wait in the inbox, payload and all, until retention removes them: a subscriber that stays
	 * detached longer than the retention window loses the unsends that were waiting for it.
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
	/** LINE's API through the plugin's token; see `LineApiPort`. */
	readonly api: LineApiPort;
	/**
	 * Attaches the one screen of the webhook; a second is refused (throws). Attach it during setup:
	 * the listeners open only after every plugin is set up, so no request arrives before it. Until one
	 * is attached, and after it is detached, every event is kept. Returns the function that detaches it.
	 */
	screen(handler: LineScreen): () => void;
}

export const LINE = serviceKey<LineBridgePort>("roundtable.line", {
	absent:
		"add the line() plugin from pi-roundtable-line to the host's plugins before the plugin that reads it",
});
