import {
	type Approval,
	type ApprovalDetails,
	type AskSupport,
	checkAnswer,
	checkQuestionnaireAnswer,
	type OwnerAnswer,
	type OwnerQuestion,
	type PromptScope,
	type Prompts,
	type Questionnaire,
	type QuestionnaireAnswer,
	TIERS,
	type Tier,
	withdrawalNote,
} from "pi-roundtable";
import type { Connection } from "./connections.ts";
import {
	APPROVAL_MAX_BYTES,
	type ClientFrame,
	type ErrorCode,
	type PromptFrame,
	type PromptOutcome,
	type ServerFrame,
} from "./protocol.ts";

/** Who answers: the conversation's person, at their tier as of the answer. */
export interface Answerer {
	principalId: string;
	tier: Tier;
}

interface Open {
	conversation: string;
	principal: string;
	frame: PromptFrame;
	/** The lowest tier that may approve; questions have none. */
	minTier?: Tier;
	/** A questionnaire: the connections it was sent to, which are the only ones told it closed. */
	sentTo?: Set<Connection>;
	/** A questionnaire no connection can show waits this long for one to, then expires. */
	grace?: ReturnType<typeof setTimeout>;
	settle(
		outcome: PromptOutcome,
		answer?: OwnerAnswer | QuestionnaireAnswer,
		note?: string,
	): void;
}

export interface PromptDeskOptions {
	/** Sends a frame to every connection of a person. */
	send(principal: string, frame: ServerFrame): void;
	/** Sends a frame to the connections of a person that `where` accepts. */
	sendWhere(
		principal: string,
		frame: ServerFrame,
		where: (connection: Connection) => boolean,
	): void;
	/** What the open connections of a person declared they can show of a questionnaire. */
	supports(principal: string): AskSupport[];
	/** Sends a frame on one connection. */
	sendOne(connection: Connection, frame: ServerFrame): void;
	/** An unanswered prompt expires after this long. */
	timeoutMs: number;
	/** How long a questionnaire that no connection can show waits for one (default 60 seconds). */
	graceMs?: number;
}

const GRACE_MS = 60_000;

const atLeast = (tier: Tier, least: Tier) =>
	TIERS.indexOf(tier) >= TIERS.indexOf(least);

/**
 * The approvals and questions open in web conversations. A prompt goes to every connection of
 * the conversation's person, survives a reconnect (each `ready` sends the open ones again), and
 * closes when answered, after `timeoutMs` (expired), or when the turn stops (cancelled). Only the
 * conversation's person may answer, and an approval only at the tier it needs.
 */
export class PromptDesk {
	readonly #open = new Map<string, Open>();
	readonly #options: PromptDeskOptions;

	constructor(options: PromptDeskOptions) {
		this.#options = options;
	}

	/**
	 * The prompts of a conversation for the scope's speaker, whose turn runs there. An approval
	 * whose tier the speaker lacks comes back `unavailable` at once without being shown: no one else can answer in
	 * a private conversation, so the call stays held, as an unanswered card leaves it.
	 */
	prompts(conversation: string, scope: PromptScope): Prompts {
		const desk = this;
		return {
			confirm: async (
				title,
				message,
				signal,
				minTier = "owner",
				_wait,
				details,
				options,
			) => {
				if (!atLeast(scope.tier, minTier)) return "unavailable";
				const outcome = await this.#ask(
					conversation,
					scope.principalId,
					(id) => ({
						id,
						kind: "approval",
						title,
						message,
						...(details ? { approval: boundedApproval(details) } : {}),
					}),
					signal,
					minTier,
					options?.supersede,
					options?.approvedPrompt,
				);
				return toApproval(outcome.outcome);
			},
			ask: async (title, question, signal) => {
				const { outcome, answer } = await this.#ask<OwnerAnswer>(
					conversation,
					scope.principalId,
					(id) => questionFrame(id, title, question),
					signal,
				);
				return outcome === "answered" ? answer : undefined;
			},
			// The minimum of what the person's declaring panels show; read when asked, so a panel
			// that connects mid-turn counts. None declared means the 0.19 contract.
			get asks() {
				return desk.#asksFor(scope.principalId);
			},
			get questionnaire() {
				const asks = desk.#asksFor(scope.principalId);
				if (!asks || (asks.questions < 2 && !asks.previews)) return undefined;
				return async (
					title: string,
					questionnaire: Questionnaire,
					signal?: AbortSignal,
				) => {
					const { outcome, answer } = await desk.#ask<QuestionnaireAnswer>(
						conversation,
						scope.principalId,
						(id) => ({
							id,
							kind: "questionnaire",
							title,
							questions: questionnaire.questions.map((q) => ({
								...q,
								options: q.options.map((option) => ({ ...option })),
							})),
						}),
						signal,
					);
					return outcome === "answered" ? answer : undefined;
				};
			},
		};
	}

	/** The field-wise minimum of the person's declared supports; undefined when none declared. */
	#asksFor(principal: string): AskSupport | undefined {
		const supports = this.#options.supports(principal);
		const [first, ...rest] = supports;
		if (!first) return undefined;
		return rest.reduce<AskSupport>(
			(least, s) => ({
				questions: Math.min(least.questions, s.questions),
				previews: least.previews && s.previews,
				note: least.note && s.note,
			}),
			first,
		);
	}

	/**
	 * The open prompts of a person, as frames to send again when they connect. A questionnaire is
	 * left out unless the connection declared `support` that covers it.
	 */
	openFor(principal: string, support?: AskSupport): ServerFrame[] {
		return [...this.#open.values()]
			.filter(
				(open) => open.principal === principal && showable(open.frame, support),
			)
			.map((open) => ({
				type: "prompt",
				conversation: open.conversation,
				prompt: open.frame,
			}));
	}

	/**
	 * A connection of the person closed. A questionnaire that no remaining connection can show
	 * would leave the turn waiting for an answer no one can give, so it gets a grace period for a
	 * panel to reconnect and declare, then expires and the model is told it went unanswered.
	 */
	closed(principal: string): void {
		this.#regrace(principal);
	}

	/** Starts or cancels the grace timer of each open questionnaire of a person. */
	#regrace(principal: string): void {
		const supports = this.#options.supports(principal);
		for (const open of this.#open.values()) {
			if (open.principal !== principal || open.frame.kind !== "questionnaire")
				continue;
			const frame = open.frame;
			if (supports.some((s) => showable(frame, s))) {
				clearTimeout(open.grace);
				open.grace = undefined;
			} else if (!open.grace) {
				open.grace = setTimeout(
					() => open.settle("expired"),
					this.#options.graceMs ?? GRACE_MS,
				);
			}
		}
	}

	/** Approves or declines; an error code when the prompt is not an approval this person may answer. */
	approve(
		from: Answerer,
		prompt: string,
		approved: boolean,
	): ErrorCode | undefined {
		const open = this.#open.get(prompt);
		if (open?.frame.kind !== "approval") return "unknown_prompt";
		if (open.principal !== from.principalId) return "forbidden";
		if (open.minTier && !atLeast(from.tier, open.minTier)) return "forbidden";
		open.settle(approved ? "approved" : "declined");
		return undefined;
	}

	/** Answers a question; an error code when the answer does not fit the question or the person may not answer it. */
	answer(
		from: Answerer,
		prompt: string,
		answer: OwnerAnswer,
	): ErrorCode | undefined {
		const open = this.#open.get(prompt);
		if (open?.frame.kind !== "ask") return "unknown_prompt";
		if (open.principal !== from.principalId) return "forbidden";
		if (!checkAnswer(open.frame, answer)) return "bad_frame";
		open.settle("answered", answer);
		return undefined;
	}

	/**
	 * Takes the frames that concern questionnaires: `prompt_features` declares what the connection
	 * shows and sends it the open questionnaires it can now show, and `answers` answers one.
	 * An error code when the frame is refused.
	 */
	receive(
		connection: Connection,
		from: Answerer,
		frame: Extract<ClientFrame, { type: "prompt_features" | "answers" }>,
	): ErrorCode | undefined {
		if (frame.type === "answers") return this.#answers(from, frame);
		const before = connection.askSupport;
		connection.askSupport = frame.ask;
		const changed =
			!before ||
			before.questions !== frame.ask.questions ||
			before.previews !== frame.ask.previews ||
			before.note !== frame.ask.note;
		// A repeated declaration (each `ready` asks for one) does not send what is already shown.
		if (changed)
			for (const open of this.#open.values())
				if (
					open.principal === from.principalId &&
					open.sentTo &&
					showable(open.frame, frame.ask) &&
					!(open.sentTo.has(connection) && showable(open.frame, before))
				) {
					open.sentTo.add(connection);
					this.#options.sendOne(connection, {
						type: "prompt",
						conversation: open.conversation,
						prompt: open.frame,
					});
				}
		this.#regrace(from.principalId);
		return undefined;
	}

	#answers(
		from: Answerer,
		frame: Extract<ClientFrame, { type: "answers" }>,
	): ErrorCode | undefined {
		const open = this.#open.get(frame.prompt);
		if (open?.frame.kind !== "questionnaire") return "unknown_prompt";
		if (open.principal !== from.principalId) return "forbidden";
		const answer: QuestionnaireAnswer = {
			answers: frame.answers.map((a) =>
				a === null || !(a.choices.length > 0 || a.text?.trim())
					? undefined
					: {
							choices: a.choices,
							...(a.text?.trim() ? { text: a.text.trim() } : {}),
						},
			),
			...(frame.note?.trim() ? { note: frame.note.trim() } : {}),
		};
		if (!checkQuestionnaireAnswer({ questions: open.frame.questions }, answer))
			return "bad_frame";
		open.settle("answered", answer);
		return undefined;
	}

	#ask<A extends OwnerAnswer | QuestionnaireAnswer = OwnerAnswer>(
		conversation: string,
		principal: string,
		frameOf: (id: string) => PromptFrame,
		signal: AbortSignal | undefined,
		minTier?: Tier,
		supersede?: AbortSignal,
		approvedPrompt?: (prompt: string) => void,
	): Promise<{ outcome: PromptOutcome; answer?: A }> {
		const { send, timeoutMs } = this.#options;
		if (signal?.aborted || supersede?.aborted)
			return Promise.resolve({ outcome: "cancelled" });
		return new Promise((resolve) => {
			const id = crypto.randomUUID();
			const frame = frameOf(id);
			// A questionnaire reaches only the connections that declared support covering it.
			const sentTo = new Set<Connection>();
			const sendQuestionnaire = (out: ServerFrame) =>
				this.#options.sendWhere(principal, out, (connection) => {
					if (out.type === "prompt_closed") return sentTo.has(connection);
					const shows = showable(frame, connection.askSupport);
					if (shows) sentTo.add(connection);
					return shows;
				});
			const onAbort = () => settle("cancelled");
			const timer = setTimeout(() => settle("expired"), timeoutMs);
			const onSupersede = () =>
				supersede &&
				settle("withdrawn", undefined, withdrawalNote(supersede, ""));
			const settle = (
				outcome: PromptOutcome,
				answer?: OwnerAnswer | QuestionnaireAnswer,
				note?: string,
			) => {
				// Whichever of an answer and a withdrawal comes first settles the prompt.
				const open = this.#open.get(id);
				if (!open || !this.#open.delete(id)) return;
				clearTimeout(open.grace);
				// Heard before the approval resolves, so the call that runs on it can say which card it was.
				if (outcome === "approved") approvedPrompt?.(id);
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				supersede?.removeEventListener("abort", onSupersede);
				const closed: ServerFrame = {
					type: "prompt_closed",
					conversation,
					prompt: id,
					outcome,
					...(note ? { note } : {}),
				};
				if (frame.kind === "questionnaire") sendQuestionnaire(closed);
				else send(principal, closed);
				resolve(answer ? { outcome, answer: answer as A } : { outcome });
			};
			this.#open.set(id, {
				conversation,
				principal,
				frame,
				...(minTier ? { minTier } : {}),
				...(frame.kind === "questionnaire" ? { sentTo } : {}),
				settle,
			});
			signal?.addEventListener("abort", onAbort, { once: true });
			supersede?.addEventListener("abort", onSupersede, { once: true });
			const shown: ServerFrame = {
				type: "prompt",
				conversation,
				prompt: frame,
			};
			if (frame.kind === "questionnaire") {
				sendQuestionnaire(shown);
				// Sent to no one: wait the grace for a panel that can show it, never the full timeout.
				// With no tab connected at all this waits too, so a reconnect can still rescue it.
				this.#regrace(principal);
			} else send(principal, shown);
		});
	}
}

type ApprovalFrame = NonNullable<
	Extract<PromptFrame, { kind: "approval" }>["approval"]
>;

/**
 * The approval as the frame carries it: whole while its JSON is within `APPROVAL_MAX_BYTES`.
 * Over that, each string value of the input is cut to the most code points that fit, marked
 * `… [N chars]`, and `truncated` is set; an input that does not fit even then is sent as `{}`
 * with no files. The copy text is only informational, so it is carried after the input is
 * settled and only if it fits then, never at the input's cost. The card's `message` text always
 * accompanies it.
 */
function boundedApproval(details: ApprovalDetails): ApprovalFrame {
	const size = (value: unknown) =>
		new TextEncoder().encode(JSON.stringify(value)).length;
	if (size(details) <= APPROVAL_MAX_BYTES) return details;
	const { copy, ...withoutCopy } = details;
	const bounded = boundedWithoutCopy(withoutCopy, size);
	if (!copy) return bounded;
	const candidate: ApprovalFrame = { ...bounded, copy };
	return size(candidate) <= APPROVAL_MAX_BYTES ? candidate : bounded;
}

/** `boundedApproval` for details without a copy text. */
function boundedWithoutCopy(
	details: Omit<ApprovalDetails, "copy">,
	size: (value: unknown) => number,
): ApprovalFrame {
	if (size(details) <= APPROVAL_MAX_BYTES) return details;
	const { files: _files, ...base } = details;
	const fits = (limit: number): ApprovalFrame | undefined => {
		const candidate: ApprovalFrame = {
			...base,
			input: cutStrings(details.input, limit) as Record<string, unknown>,
			truncated: true,
		};
		return size(candidate) <= APPROVAL_MAX_BYTES ? candidate : undefined;
	};
	let low = 0;
	let high = longestString(details.input);
	let best = fits(0);
	if (!best) return { ...base, input: {}, truncated: true };
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		const candidate = fits(mid);
		if (candidate) {
			best = candidate;
			low = mid;
		} else high = mid - 1;
	}
	return best;
}

/** Code points in `text`. */
const pointsOf = (text: string) => Array.from(text).length;

/** The longest string anywhere in `value`, in code points. */
// pi-lens-ignore: no-unknown-parameters — tool input is untyped model JSON; this is where it is read
function longestString(value: unknown): number {
	if (typeof value === "string") return pointsOf(value);
	if (Array.isArray(value))
		return Math.max(0, ...value.map((v: unknown) => longestString(v)));
	if (value && typeof value === "object")
		return Math.max(
			0,
			...Object.values(value).map((v: unknown) => longestString(v)),
		);
	return 0;
}

/** `value` with each string longer than `limit` code points cut to its start plus `… [N chars]`. */
// pi-lens-ignore: no-unknown-parameters — tool input is untyped model JSON; this is where it is read
function cutStrings(value: unknown, limit: number): unknown {
	if (typeof value === "string") {
		if (value.length <= limit) return value;
		const points = Array.from(value);
		if (points.length <= limit) return value;
		return `${points.slice(0, limit).join("")}… [${points.length} chars]`;
	}
	if (Array.isArray(value))
		return value.map((v: unknown) => cutStrings(v, limit));
	if (value && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value).map(([k, v]) => [k, cutStrings(v, limit)]),
		);
	return value;
}

function toApproval(outcome: PromptOutcome): Approval {
	if (outcome === "approved" || outcome === "declined") return outcome;
	// A withdrawal is read as the turn's wait ending; the gate knows it was withdrawn.
	return outcome === "cancelled" || outcome === "withdrawn"
		? "cancelled"
		: "expired";
}

function questionFrame(
	id: string,
	title: string,
	question: OwnerQuestion,
): PromptFrame {
	return {
		id,
		kind: "ask",
		title,
		question: question.question,
		options: question.options.map((option) => ({ ...option })),
		multi: question.multi,
		allowOther: question.allowOther,
	};
}

/**
 * Whether a connection with `support` may be sent the prompt: every prompt but a questionnaire,
 * which only a connection that declared support covering its questions and previews may have.
 */
function showable(
	frame: PromptFrame,
	support: AskSupport | undefined,
): boolean {
	if (frame.kind !== "questionnaire") return true;
	if (!support) return false;
	if (frame.questions.length > support.questions) return false;
	const previews = frame.questions.some((q) =>
		q.options.some((o) => o.preview),
	);
	return support.previews || !previews;
}
