import {
	type ActorFacts,
	type Approval,
	type ApprovedBy,
	type ChannelKey,
	checkAnswer,
	checkQuestionnaireAnswer,
	type LateAnswer,
	type Logger,
	type OwnerAnswer,
	type PromptScope,
	type Prompts,
	QUESTIONNAIRE_LIMITS,
	type QuestionnaireAnswer,
	SYSTEM_PRINCIPAL,
	TIERS,
	type Tier,
	withdrawalNote,
} from "pi-roundtable";
import type {
	PromptAnswer,
	PromptFrame,
	PromptOutcome,
	RefusalCode,
	ServerFrame,
} from "../api-types.ts";
import {
	askFrame,
	boundedApproval,
	questionnaireFrame,
	wordingFrame,
} from "./frames.ts";

/** How long a card stays open when no one answers it: 24 hours, as a held action does. */
export const CARD_TTL_MS = 24 * 3_600_000;

/** What the app's cards show of a questionnaire: every question, previews and a note. */
const APP_ASKS = Object.freeze({
	questions: QUESTIONNAIRE_LIMITS.questions,
	previews: true,
	note: true,
});

/** Who answers: an owner visitor, at their tier as of the answer. */
export interface Answerer {
	principalId: string;
	tier: Tier;
	/** The identity they spoke as, `<provider>:<subject>`. */
	speakerId: string;
	name: string;
	/** The actor their credential vouched for, which a message they start is written as. */
	actor?: ActorFacts;
}

export interface OwnerDeskOptions {
	/** Sends a frame to every open socket of every owner. */
	broadcast(frame: ServerFrame): void;
	/** How long a turn that can be resumed waits on its card before it goes on without the answer. */
	graceMs: number;
	/** A card nobody answers closes after this long; default 24 hours. */
	ttlMs?: number;
	/**
	 * Starts a turn in a room with a late answer's text, as a message from whoever answered. A
	 * rejection is logged.
	 */
	resume(room: ChannelKey, by: Answerer, text: string): void | Promise<void>;
	/** Display names of principals, for a card that names who may approve it. */
	namesOf(principalIds: readonly string[]): Promise<string[]>;
	logger: Logger;
}

/** What an answer, once checked, says. */
type Ended =
	| { type: "approval"; approved: boolean }
	| { type: "answer"; answer: OwnerAnswer }
	| { type: "answers"; answer: QuestionnaireAnswer }
	/** The question card's Cancel. */
	| { type: "cancel" };

interface Open {
	room: ChannelKey;
	frame: PromptFrame;
	/** Whether this person may answer the card. */
	admits(from: Answerer): boolean;
	end(ended: Ended, by: Answerer): void;
	/** Ends the card without an answer, as a stopped turn does. */
	abandon(): void;
}

/** What a card gives the turn that waits on it, and what a late answer says to a new turn. */
interface Card<T> {
	room: ChannelKey;
	frame: PromptFrame;
	signal: AbortSignal | undefined;
	supersede: AbortSignal | undefined;
	/** Present when the turn may stop waiting: what it is told then. */
	pending?: T;
	cancelled: T;
	expired: T;
	admits(from: Answerer): boolean;
	/** The turn's result for an answer given while it still waits. */
	valueOf(ended: Ended): T;
	/** A hook before an approval resolves `approved`. */
	approved?(by: Answerer, prompt: string): void;
	/** The text a late answer starts a turn with; undefined starts none. */
	lateText?(ended: Ended, by: Answerer, prompt: string): string | undefined;
}

const atLeast = (tier: Tier, least: Tier) =>
	TIERS.indexOf(tier) >= TIERS.indexOf(least);

const outcomeOf = (ended: Ended): PromptOutcome => {
	if (ended.type === "approval")
		return ended.approved ? "approved" : "declined";
	return ended.type === "cancel" ? "declined" : "answered";
};

/**
 * The cards open in the app's rooms: approvals of held actions and questions the turn asks. Every
 * card goes to every socket of every owner, survives a reconnect (each `ready` sends the open
 * ones again), and closes when answered, when its turn stops, when the plugin withdraws it, or
 * after a day. A turn that can be resumed stops waiting after the grace period while the card
 * stays open (`late`); answered then, the card starts a turn in its room with the answer.
 *
 * Who answers: any owner, except a card that is the speaker's alone (`speakerOnly`), which only
 * the speaker's principal answers, and a card in a private conversation, which only its person
 * does. An approval is answered at the tier it needs, read again when the answer comes.
 */
export class OwnerDesk {
	readonly #open = new Map<string, Open>();
	readonly #options: OwnerDeskOptions;

	constructor(options: OwnerDeskOptions) {
		this.#options = options;
	}

	/** The prompts of a room for the scope's turn. */
	prompts(room: ChannelKey, scope?: PromptScope): Prompts {
		const { namesOf } = this.#options;
		return {
			confirm: async (
				title,
				message,
				signal,
				minTier = "owner",
				wait,
				details,
				options,
			) => {
				const speakerOnly = options?.speakerOnly === true;
				const audience = this.#approvalAudience(
					scope,
					minTier,
					options?.approvers,
					speakerOnly,
				);
				if (!audience) return "unavailable";
				const approvers = options?.approvers?.length
					? await namesOf(options.approvers)
					: undefined;
				const id = crypto.randomUUID();
				return this.#post<Approval>({
					room,
					frame: {
						id,
						kind: "approval",
						title,
						message,
						purpose: options?.purpose ?? "action",
						...(details ? { approval: boundedApproval(details) } : {}),
						...(options?.wording
							? { wording: wordingFrame(options.wording) }
							: {}),
						...(speakerOnly ? { speakerOnly: true as const } : {}),
						...(approvers ? { approvers } : {}),
					},
					signal,
					supersede: options?.supersede,
					...(wait ? { pending: "pending" as const } : {}),
					cancelled: "cancelled",
					expired: "expired",
					admits: audience,
					valueOf: (ended) =>
						ended.type === "approval" && ended.approved
							? "approved"
							: "declined",
					approved: (by, prompt) => {
						options?.approvedBy?.(approvedBy(by));
						options?.approvedPrompt?.(prompt);
					},
					lateText: (ended, by, prompt) =>
						ended.type === "approval"
							? wait?.late({
									kind: "approval",
									approved: ended.approved,
									by: by.name,
									approvedBy: approvedBy(by),
									prompt,
								})
							: undefined,
				});
			},
			ask: async (title, question, signal, wait) => {
				const id = crypto.randomUUID();
				return this.#post<OwnerAnswer | "pending" | "declined" | undefined>({
					room,
					frame: askFrame(id, title, question),
					signal,
					supersede: undefined,
					...(wait ? { pending: "pending" as const } : {}),
					cancelled: undefined,
					expired: undefined,
					admits: this.#questionAudience(scope),
					valueOf: (ended) =>
						ended.type === "answer" ? ended.answer : "declined",
					lateText: (ended, by) =>
						ended.type === "answer"
							? wait?.late({
									kind: "question",
									answer: ended.answer,
									by: by.name,
								})
							: undefined,
				});
			},
			asks: APP_ASKS,
			questionnaire: async (title, questionnaire, signal, wait) => {
				const id = crypto.randomUUID();
				return this.#post<
					QuestionnaireAnswer | "pending" | "declined" | undefined
				>({
					room,
					frame: questionnaireFrame(id, title, questionnaire),
					signal,
					supersede: undefined,
					...(wait ? { pending: "pending" as const } : {}),
					cancelled: undefined,
					expired: undefined,
					admits: this.#questionAudience(scope),
					valueOf: (ended) =>
						ended.type === "answers" ? ended.answer : "declined",
					lateText: (ended, by) =>
						ended.type === "answers"
							? wait?.late({
									kind: "questionnaire",
									answer: ended.answer,
									by: by.name,
								})
							: undefined,
				});
			},
		};
	}

	/** The open cards as frames, to send again when a socket opens. */
	openFrames(): ServerFrame[] {
		return [...this.#open.values()].map((open) => ({
			type: "prompt",
			room: open.room,
			prompt: open.frame,
		}));
	}

	/** Approves or declines; a code when the card is not an approval this person may answer. */
	approve(
		from: Answerer,
		prompt: string,
		approved: boolean,
	): RefusalCode | undefined {
		const open = this.#open.get(prompt);
		if (open?.frame.kind !== "approval") return "unknown_prompt";
		if (!open.admits(from)) return "forbidden";
		open.end({ type: "approval", approved }, from);
		return undefined;
	}

	/** Answers a question card; a code when the answer does not fit it or this person may not answer. */
	answer(
		from: Answerer,
		prompt: string,
		answer: PromptAnswer,
	): RefusalCode | undefined {
		const open = this.#open.get(prompt);
		if (open?.frame.kind !== "ask") return "unknown_prompt";
		if (!open.admits(from)) return "forbidden";
		const given: OwnerAnswer = {
			choices: answer.choices,
			...(answer.text?.trim() ? { text: answer.text.trim() } : {}),
		};
		if (!checkAnswer(open.frame, given)) return "bad_frame";
		open.end({ type: "answer", answer: given }, from);
		return undefined;
	}

	/** Answers a questionnaire card. */
	answers(
		from: Answerer,
		prompt: string,
		answers: readonly (PromptAnswer | null)[],
		note?: string,
	): RefusalCode | undefined {
		const open = this.#open.get(prompt);
		if (open?.frame.kind !== "questionnaire") return "unknown_prompt";
		if (!open.admits(from)) return "forbidden";
		const answer: QuestionnaireAnswer = {
			answers: answers.map((a) =>
				a === null || !(a.choices.length > 0 || a.text?.trim())
					? undefined
					: {
							choices: a.choices,
							...(a.text?.trim() ? { text: a.text.trim() } : {}),
						},
			),
			...(note?.trim() ? { note: note.trim() } : {}),
		};
		if (!checkQuestionnaireAnswer({ questions: open.frame.questions }, answer))
			return "bad_frame";
		open.end({ type: "answers", answer }, from);
		return undefined;
	}

	/** Cancels a question or questionnaire card; the turn is told `declined`. */
	cancel(from: Answerer, prompt: string): RefusalCode | undefined {
		const open = this.#open.get(prompt);
		if (!open || open.frame.kind === "approval") return "unknown_prompt";
		if (!open.admits(from)) return "forbidden";
		open.end({ type: "cancel" }, from);
		return undefined;
	}

	/**
	 * Who may approve a call held at `minTier`, as a test of the person who answers; undefined when
	 * no one may, so the call is unavailable at once. The primary audience is every owner.
	 */
	#approvalAudience(
		scope: PromptScope | undefined,
		minTier: Tier,
		approvers: readonly string[] | undefined,
		speakerOnly: boolean,
	): ((from: Answerer) => boolean) | undefined {
		const tierOk = (from: Answerer) => atLeast(from.tier, minTier);
		if (speakerOnly) {
			// The speaker's alone: below the tier, or a speaker who is no person, no one answers.
			if (
				!scope ||
				scope.principalId === SYSTEM_PRINCIPAL ||
				!atLeast(scope.tier, minTier)
			)
				return undefined;
			const speaker = scope.principalId;
			return (from) => from.principalId === speaker && tierOk(from);
		}
		if (scope?.escalate === "none") {
			// A private conversation's person is the only one who answers, and a call naming others is theirs only if named or an owner.
			if (!atLeast(scope.tier, minTier)) return undefined;
			if (
				approvers?.length &&
				!approvers.includes(scope.principalId) &&
				scope.tier !== "owner"
			)
				return undefined;
			const person = scope.principalId;
			return (from) => from.principalId === person && tierOk(from);
		}
		return tierOk;
	}

	/** Who may answer a question: every owner, or a private conversation's person alone. */
	#questionAudience(scope: PromptScope | undefined) {
		if (scope?.escalate === "none") {
			const person = scope.principalId;
			return (from: Answerer) => from.principalId === person;
		}
		return (_from: Answerer) => true;
	}

	/**
	 * Shows a card and resolves with its answer, `cancelled` when its turn stops, `expired` after
	 * the day, or `pending` once the grace period passes for a turn that can be resumed.
	 */
	#post<T>(card: Card<T>): Promise<T> {
		const { broadcast, graceMs, logger } = this.#options;
		const ttlMs = this.#options.ttlMs ?? CARD_TTL_MS;
		const { signal, supersede, room } = card;
		if (signal?.aborted || supersede?.aborted)
			return Promise.resolve(card.cancelled);
		const id = card.frame.id;
		return new Promise<T>((resolve) => {
			let late = false;
			let grace: ReturnType<typeof setTimeout> | undefined;
			const open: Open = {
				room,
				frame: card.frame,
				admits: card.admits,
				abandon: () => onAbort(),
				end: (ended, by) => {
					if (!this.#open.has(id)) return;
					const answeredLate = late;
					if (!answeredLate && ended.type === "approval" && ended.approved)
						card.approved?.(by, id);
					close(outcomeOf(ended));
					if (!answeredLate) {
						resolve(card.valueOf(ended));
						return;
					}
					try {
						const text = card.lateText?.(ended, by, id);
						if (text === undefined) return;
						Promise.resolve(this.#options.resume(room, by, text)).catch(
							(error: unknown) =>
								logger.warn({ room, err: error }, "late card answer lost"),
						);
					} catch (error) {
						logger.warn({ room, err: error }, "late card answer lost");
					}
				},
			};
			const close = (outcome: PromptOutcome, note?: string) => {
				if (!this.#open.delete(id)) return;
				clearTimeout(grace);
				clearTimeout(ttl);
				signal?.removeEventListener("abort", onAbort);
				supersede?.removeEventListener("abort", onWithdraw);
				broadcast({
					type: "prompt_closed",
					prompt: id,
					outcome,
					...(note ? { note } : {}),
				});
			};
			const onAbort = () => {
				if (!this.#open.has(id)) return;
				close("cancelled");
				resolve(card.cancelled);
			};
			const onWithdraw = () => {
				if (!this.#open.has(id) || !supersede) return;
				const wasLate = late;
				close("withdrawn", withdrawalNote(supersede, ""));
				if (!wasLate) resolve(card.cancelled);
			};
			const ttl = setTimeout(() => {
				if (!this.#open.has(id)) return;
				const wasLate = late;
				close("expired");
				if (!wasLate) resolve(card.expired);
			}, ttlMs);
			if (card.pending !== undefined)
				grace = setTimeout(() => {
					if (!this.#open.has(id)) return;
					late = true;
					signal?.removeEventListener("abort", onAbort);
					open.frame = { ...open.frame, late: true } as PromptFrame;
					broadcast({ type: "prompt", room, prompt: open.frame });
					resolve(card.pending as T);
				}, graceMs);
			signal?.addEventListener("abort", onAbort, { once: true });
			supersede?.addEventListener("abort", onWithdraw, { once: true });
			this.#open.set(id, open);
			broadcast({ type: "prompt", room, prompt: open.frame });
		});
	}

	/** Closes every open card as cancelled and clears their timers, when the app stops. */
	stop(): void {
		for (const open of [...this.#open.values()]) open.abandon();
	}
}

function approvedBy(by: Answerer): ApprovedBy {
	return {
		principalId: by.principalId,
		speakerId: by.speakerId,
		name: by.name,
		...(by.tier === "owner" ? { owner: true as const } : {}),
	};
}

export type { LateAnswer };
