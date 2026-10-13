import { serviceKey } from "pi-roundtable";
import type { InboxProcessor } from "./inbox.ts";
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
	 * Takes the inbox: from now on each stored event of an allowed chat (and the join and leave of
	 * any chat) is handed to `processor`, oldest first within a chat. Only one processor may be
	 * attached; returns the function that detaches it. Until one is attached events wait in the
	 * inbox, payload and all, until retention removes them.
	 */
	attachProcessor(processor: InboxProcessor): () => void;
}

export const LINE = serviceKey<LineBridgePort>("roundtable.line", {
	absent:
		"add the line() plugin from pi-roundtable-line to the host's plugins before the plugin that reads it",
});
