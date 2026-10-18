import type { TextDisplayBuilder } from "discord.js";
import type {
	ApprovedBy,
	OwnerQuestion,
	PromptWait,
} from "../interactions/prompts.ts";
import type { Questionnaire } from "../interactions/questionnaire.ts";
import type { Audience } from "./card-audience.ts";
import type { DiscordUser } from "./discord-owners.ts";
import type { QuestionnaireForm } from "./owner-card-questionnaire.ts";
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
	/** The card as it looks now: open, or ended with `footer` and its controls disabled. */
	view(footer: string, disabled?: boolean): CardPayload;
	/** Restarts the grace period of a turn that waits on the card; a draft edit is someone at work on it. */
	touch(): void;
	/** Whether the card is still open: not answered, stopped or withdrawn. */
	isOpen(): boolean;
	/**
	 * Ends the card with its answer; the answering interaction shows the outcome. A card whose
	 * turn stopped waiting starts a turn with the answer instead. False when the card had ended
	 * already, answered by another press or withdrawn by its plugin, and this answer changed nothing.
	 */
	end(value: unknown, by: Answerer): boolean;
	question?: OwnerQuestion;
	/** A questionnaire card's questions and its shared draft. */
	form?: QuestionnaireForm;
	/** The questions whose previews the Previews button shows, on a card that is not a questionnaire card. */
	previews?: Questionnaire;
	/** Options chosen together with "Other…", kept while its form is open. */
	picked?: string[];
	/** Posted in a thread, so it leads with the mention of who may answer. */
	mention?: boolean;
	/** Who may answer, and what to tell someone else who presses it. */
	audience: Audience;
}

/** What `#post` needs to post one card; `T` is what the card resolves with. */
export interface CardSpec<T> {
	audience: Audience;
	title: string;
	sections: string[];
	/** The text behind the card's copy button, kept under the card's id. */
	copy?: string;
	/** Closes the card, also after its turn stopped waiting, when it aborts; see `ApprovalOptions.supersede`. */
	supersede?: AbortSignal;
	question?: OwnerQuestion;
	form?: QuestionnaireForm;
	previews?: Questionnaire;
	/** Draws the card itself, as a questionnaire does; without it the card is the title, sections and rows. */
	build?(id: string, footer: string, disabled: boolean): CardPayload;
	rows?(id: string, disabled: boolean): Rows;
	footer: string;
	wait?: {
		pending: T;
		late(
			value: unknown,
			by: Answerer,
			prompt: string,
		): ReturnType<PromptWait["late"]>;
	};
	/** Hears who approved the card, before it resolves approved in its turn. */
	approved?(by: Answerer, prompt: string): void;
}

/** Posts a card and resolves with its answer; see `OwnerCards`. */
export type PostCard = <T>(
	channelId: string,
	signal: AbortSignal | undefined,
	unposted: T,
	cancelled: T,
	card: CardSpec<T>,
) => Promise<T>;
