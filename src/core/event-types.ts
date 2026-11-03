import type { ChannelKey } from "./sessions.ts";

/** One thing a person did through a plugin's surface, as a handler hears of it. */
export interface ActionEvent {
	/** What was done, in the reporting plugin's words, such as "assign" or "close". */
	kind: string;
	/** The `Speaker.id` of who did it. */
	actor: string;
	principalId: string;
	/** The conversation or page it concerns, when there is one. */
	channel?: ChannelKey | `page:${string}`;
	/** Whether it worked. */
	ok: boolean;
	at: Date;
}

/** Someone joined a server of a chat network, as a handler hears of it. */
export interface MemberJoinedEvent {
	/** The chat network the server is on. */
	surface: "discord";
	/** The server's id. */
	guildId: string;
	/** The id of whoever joined. */
	userId: string;
	/** Whether the one who joined is a bot. */
	bot: boolean;
}
