import type { TextDisplayBuilder } from "discord.js";
import type { ApprovedBy, OwnerQuestion } from "../interactions/prompts.ts";
import type { Audience } from "./card-audience.ts";
import type { DiscordUser } from "./discord-owners.ts";
import type { Rows } from "./owner-card-rows.ts";
import type { ownerPanel } from "./owner-panel.ts";

/** A card's message: the panel, led in a thread by a mention of those it is for. */
export type CardPayload = Omit<
	ReturnType<typeof ownerPanel>,
	"components" | "allowedMentions"
> & {
	components: (
		| ReturnType<typeof ownerPanel>["components"][number]
		| TextDisplayBuilder
	)[];
	allowedMentions: { parse?: never[]; users?: string[] };
};

/** The posted card, which is edited to show how it ended. */
export interface CardMessage {
	edit(payload: CardPayload): Promise<unknown>;
}

/** Where a channel's cards are posted. */
export interface CardChannel {
	send(payload: CardPayload): Promise<CardMessage>;
	/** A thread, where those a card is for are mentioned so they hear of it; a channel mentions no one. */
	thread?: boolean;
}

/** A turn a card answered after its turn stopped waiting starts, as a message in its channel. */
export interface LateTurn {
	channelId: string;
	/** The card's message, which the turn's message stands for. */
	messageId: string;
	/** Who answered. */
	user: DiscordUser;
	/** The server the channel belongs to; absent in a direct message. */
	guildId?: string;
	isDirect: boolean;
	text: string;
}

/** Where and by whom a card was answered. */
export interface Answerer {
	user: DiscordUser;
	/** Who approved, for an approval card they approved. */
	approver?: ApprovedBy;
	messageId?: string;
	guildId?: string;
	isDirect: boolean;
}

/** One open card: how it looks, and how it ends. */
export interface OpenCard {
	title: string;
	sections: string[];
	/** The card's controls, disabled once it has ended. */
	rows(disabled: boolean): Rows;
	/**
	 * Ends the card with its answer; the answering interaction shows the outcome. A card whose
	 * turn stopped waiting starts a turn with the answer instead.
	 */
	end(value: unknown, by: Answerer): void;
	question?: OwnerQuestion;
	/** Options chosen together with "Other…", kept while its form is open. */
	picked?: string[];
	/** Posted in a thread, so it leads with the mention of who may answer. */
	mention?: boolean;
	/** Who may answer, and what to tell someone else who presses it. */
	audience: Audience;
}
