import {
	type Approval,
	type ChannelKey,
	checkAnswer,
	checkQuestionnaireAnswer,
	type LateAnswer,
	type OwnerAnswer,
	type PromptScope,
	type Prompts,
	QUESTIONNAIRE_LIMITS,
	type QuestionnaireAnswer,
	withdrawalNote,
} from "pi-roundtable";
import type {
	CardAnswer,
	ClosedCard,
	PromptAnswer,
	PromptFrame,
	PromptOutcome,
	RefusalCode,
	ServerFrame,
} from "../api-types.ts";
import { approvalAudience, questionAudience } from "./desk-audience.ts";
import { answerOf, approvedBy, outcomeOf, pendingOf } from "./desk-cards.ts";
import type { Answerer, Card, Open, OwnerDeskOptions } from "./desk-types.ts";
import {
	askFrame,
	boundedApproval,
	questionnaireFrame,
	wordingFrame,
} from "./frames.ts";

/** How long a card stays open when no one answers it: 24 hours, as a held action does. */
const CARD_TTL_MS = 24 * 3_600_000;

/** What the app's cards show of a questionnaire: every question, previews and a note. */
const APP_ASKS = Object.freeze({
	questions: QUESTIONNAIRE_LIMITS.questions,
	previews: true,
	note: true,
});

export type { Answerer, OwnerDeskOptions } from "./desk-types.ts";

/**
 * The cards open in the app's rooms: approvals of held actions and questions the turn asks. Every
 * card goes to every socket of every owner, survives a reconnect (each `ready` sends the open
 * ones again), and closes when answered, when its turn stops, when the plugin withdraws it, or
 * after a day. A turn that can be resumed stops waiting after the grace period while the card
 * stays open (`late`); answered then, the card starts a turn in its room with the answer.
 *
 * Who answers (the same rule as Discord's `CardAudiences`, so a room's readers cannot widen it):
 * - an approval that names approvers: a named approver who holds its tier now, or an owner;
 * - an approval that names none: the turn's speaker at its tier, and the owners when the scope
 *   escalates;
 * - a question: the speaker, and the owners when the scope escalates;
 * - a card that is the speaker's alone (`speakerOnly`): only the speaker's principal;
 * - without a scope: the owners.
 * It applies to approve, decline, answer and cancel alike, and the tier is the answerer's now.
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
				const audience = approvalAudience(
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
					...pendingOf(wait),
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
					...pendingOf(wait),
					cancelled: undefined,
					expired: undefined,
					admits: questionAudience(scope),
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
					...pendingOf(wait),
					cancelled: undefined,
					expired: undefined,
					admits: questionAudience(scope),
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

	/** The open cards as frames with their rooms, to send again when a socket opens; each goes only to those who may have its room. */
	openFrames(): { room: ChannelKey; frame: ServerFrame }[] {
		return [...this.#open.values()].map((open) => ({
			room: open.room,
			frame: { type: "prompt", room: open.room, prompt: open.frame },
		}));
	}

	/** The room a card belongs to, while it is open. */
	roomOf(prompt: string): ChannelKey | undefined {
		return this.#open.get(prompt)?.room;
	}

	/** Whether the card is open and past its grace, so an answer to it starts a turn. */
	isLate(prompt: string): boolean {
		const frame = this.#open.get(prompt)?.frame;
		return frame !== undefined && "late" in frame && frame.late === true;
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
		const frame = { ...card.frame, at: new Date().toISOString() };
		return new Promise<T>((resolve) => {
			let late = false;
			let grace: ReturnType<typeof setTimeout> | undefined;
			const open: Open = {
				room,
				frame,
				admits: card.admits,
				abandon: () => onAbort(),
				end: (ended, by) => {
					if (!this.#open.has(id)) return;
					const answeredLate = late;
					if (!answeredLate && ended.type === "approval" && ended.approved)
						card.approved?.(by, id);
					close(outcomeOf(ended), undefined, by, answerOf(ended));
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
			const close = (
				outcome: PromptOutcome,
				note?: string,
				by?: Answerer,
				answer?: CardAnswer,
			) => {
				if (!this.#open.delete(id)) return;
				clearTimeout(grace);
				clearTimeout(ttl);
				signal?.removeEventListener("abort", onAbort);
				supersede?.removeEventListener("abort", onWithdraw);
				const closedAt = new Date().toISOString();
				const ended = {
					outcome,
					...(note ? { note } : {}),
					...(by ? { by: by.name } : {}),
					...(answer ? { answer } : {}),
				};
				// Kept before the sockets are told, so a page that reloads on the news finds it.
				this.#keep({ room, frame: open.frame, ...ended, closedAt });
				broadcast(
					{ type: "prompt_closed", prompt: id, ...ended, closedAt },
					room,
				);
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
					broadcast({ type: "prompt", room, prompt: open.frame }, room);
					resolve(card.pending as T);
				}, card.graceMs ?? graceMs);
			signal?.addEventListener("abort", onAbort, { once: true });
			supersede?.addEventListener("abort", onWithdraw, { once: true });
			this.#open.set(id, open);
			broadcast({ type: "prompt", room, prompt: open.frame }, room);
			try {
				this.#options.opened?.(room, open.frame);
			} catch (error) {
				logger.warn({ room, err: error }, "a card's listener failed");
			}
		});
	}

	#keep(card: ClosedCard): void {
		const { closed, logger } = this.#options;
		if (!closed) return;
		const failed = (error: unknown) =>
			logger.warn({ room: card.room, err: error }, "a card was not kept");
		try {
			Promise.resolve(closed(card)).catch(failed);
		} catch (error) {
			failed(error);
		}
	}

	/** Closes every open card as cancelled and clears their timers, when the app stops. */
	stop(): void {
		for (const open of [...this.#open.values()]) open.abandon();
	}
}

export type { LateAnswer };
