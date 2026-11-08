// The cards the server asks the owner and how they end, shared by the server and the page; `api-types.ts` re-exports them.

/** An option of a question, as the core writes it. */
export interface PromptOption {
	label: string;
	description?: string;
	preview?: string;
}

/** One question of a card. */
export interface PromptQuestion {
	question: string;
	header?: string;
	/** None means a free-text answer. */
	options: readonly PromptOption[];
	multi: boolean;
	allowOther: boolean;
}

/** What a held call is, as data beside its markdown text. */
export interface PromptApproval {
	action: string;
	tool: string;
	input: Record<string, unknown>;
	files?: { path: string; bytes?: number }[];
	copy?: { label?: string; text: string };
	/** Set when long values of `input` were cut to fit `APPROVAL_MAX_BYTES`. */
	truncated?: true;
}

/** The card's own words in place of an approval's. */
export interface PromptWording {
	approve: string;
	decline: string;
	footer: string;
	approved: string;
	declined: string;
}

/** An answer to a question: the chosen options' labels and the person's own text. */
export interface PromptAnswer {
	choices: string[];
	text?: string;
}

/** A card the server asks the owner: an approval, a question, or several questions. */
export type PromptFrame =
	| {
			id: string;
			/** When the card opened (ISO 8601, the server's clock), which places it among the room's messages. */
			at?: string;
			kind: "approval";
			title: string;
			/** The card as markdown text. */
			message: string;
			approval?: PromptApproval;
			/** `turn-timeout` is a turn's time-limit card: continuing it lets the turn go on. */
			purpose: "action" | "turn-timeout";
			wording?: PromptWording;
			/** Only the speaker whose turn asks may answer. */
			speakerOnly?: true;
			/** Display names of the people the call names to approve it; owners may still. */
			approvers?: string[];
			/** The turn stopped waiting; an answer starts a new turn in the room. */
			late?: true;
	  }
	| {
			id: string;
			at?: string;
			kind: "ask";
			title: string;
			question: string;
			options: readonly PromptOption[];
			multi: boolean;
			allowOther: boolean;
			late?: true;
	  }
	| {
			id: string;
			at?: string;
			kind: "questionnaire";
			title: string;
			questions: readonly PromptQuestion[];
			late?: true;
	  };

/** How a card ended. `withdrawn` is a card the plugin that asked for it took back. */
export type PromptOutcome =
	| "approved"
	| "declined"
	| "answered"
	| "expired"
	| "cancelled"
	| "withdrawn";

/** What a person gave a question card: one answer, or one per question with the note beside them. */
export type CardAnswer =
	| { kind: "ask"; answer: PromptAnswer }
	| { kind: "questionnaire"; answers: (PromptAnswer | null)[]; note?: string };

/** A card that ended and is kept in its room's history, with how it ended. */
export interface ClosedCard {
	room: string;
	/** The card as it was shown, `at` being when it opened. */
	frame: PromptFrame;
	outcome: PromptOutcome;
	/** Why a `withdrawn` card was taken back. */
	note?: string;
	/** Who answered it, by display name; absent for a card nobody answered. */
	by?: string;
	/** What was answered, for the question cards. */
	answer?: CardAnswer;
	/** When it ended (ISO 8601, the server's clock). */
	closedAt: string;
}
