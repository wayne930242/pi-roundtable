import {
	type Approval,
	type OwnerAnswer,
	type OwnerPrompts,
	type OwnerQuestion,
	type Speaker,
	TIERS,
	type Tier,
} from "pi-roundtable";
import type {
	ErrorCode,
	PromptFrame,
	PromptOutcome,
	ServerFrame,
} from "./protocol.ts";

/** Who answers: the conversation's person, at their tier as of the answer. */
export interface Answerer {
	id: string;
	tier: Tier;
}

interface Open {
	conversation: string;
	principal: string;
	frame: PromptFrame;
	/** The lowest tier that may approve; questions have none. */
	minTier?: Tier;
	settle(outcome: PromptOutcome, answer?: OwnerAnswer): void;
}

export interface PromptDeskOptions {
	/** Sends a frame to every connection of a person. */
	send(principal: string, frame: ServerFrame): void;
	/** An unanswered prompt expires after this long. */
	timeoutMs: number;
}

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
	 * The prompts of a conversation for the speaker whose turn runs there. An approval whose tier
	 * the speaker lacks expires at once without being shown: no one else can answer in a private
	 * conversation, so the call stays held, as an unanswered card leaves it.
	 */
	prompts(conversation: string, speaker: Speaker): OwnerPrompts {
		return {
			confirm: async (title, message, signal, minTier = "owner") => {
				if (!atLeast(speaker.tier, minTier)) return "expired";
				const outcome = await this.#ask(
					conversation,
					speaker.id,
					(id) => ({ id, kind: "approval", title, message }),
					signal,
					minTier,
				);
				return toApproval(outcome.outcome);
			},
			ask: async (title, question, signal) => {
				const { outcome, answer } = await this.#ask(
					conversation,
					speaker.id,
					(id) => questionFrame(id, title, question),
					signal,
				);
				return outcome === "answered" ? answer : undefined;
			},
		};
	}

	/** The open prompts of a person, as frames to send again when they connect. */
	openFor(principal: string): ServerFrame[] {
		return [...this.#open.values()]
			.filter((open) => open.principal === principal)
			.map((open) => ({
				type: "prompt",
				conversation: open.conversation,
				prompt: open.frame,
			}));
	}

	/** Approves or declines; an error code when the prompt is not an approval this person may answer. */
	approve(
		from: Answerer,
		prompt: string,
		approved: boolean,
	): ErrorCode | undefined {
		const open = this.#open.get(prompt);
		if (open?.frame.kind !== "approval") return "unknown_prompt";
		if (open.principal !== from.id) return "forbidden";
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
		if (open.principal !== from.id) return "forbidden";
		if (!fits(open.frame, answer)) return "bad_frame";
		open.settle("answered", answer);
		return undefined;
	}

	#ask(
		conversation: string,
		principal: string,
		frameOf: (id: string) => PromptFrame,
		signal: AbortSignal | undefined,
		minTier?: Tier,
	): Promise<{ outcome: PromptOutcome; answer?: OwnerAnswer }> {
		const { send, timeoutMs } = this.#options;
		if (signal?.aborted) return Promise.resolve({ outcome: "cancelled" });
		return new Promise((resolve) => {
			const id = crypto.randomUUID();
			const frame = frameOf(id);
			const onAbort = () => settle("cancelled");
			const timer = setTimeout(() => settle("expired"), timeoutMs);
			const settle = (outcome: PromptOutcome, answer?: OwnerAnswer) => {
				if (!this.#open.delete(id)) return;
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				send(principal, {
					type: "prompt_closed",
					conversation,
					prompt: id,
					outcome,
				});
				resolve(answer ? { outcome, answer } : { outcome });
			};
			this.#open.set(id, {
				conversation,
				principal,
				frame,
				...(minTier ? { minTier } : {}),
				settle,
			});
			signal?.addEventListener("abort", onAbort, { once: true });
			send(principal, { type: "prompt", conversation, prompt: frame });
		});
	}
}

function toApproval(outcome: PromptOutcome): Approval {
	if (outcome === "approved" || outcome === "declined") return outcome;
	return outcome === "cancelled" ? "cancelled" : "expired";
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

/** Whether an answer is one the question allows: offered labels, one unless multi, own text only where allowed. */
function fits(
	frame: Extract<PromptFrame, { kind: "ask" }>,
	answer: OwnerAnswer,
): boolean {
	const labels = frame.options.map((option) => option.label);
	const text = answer.text?.trim();
	if (!answer.choices.every((choice) => labels.includes(choice))) return false;
	if (new Set(answer.choices).size !== answer.choices.length) return false;
	if (!frame.multi && answer.choices.length > 1) return false;
	if (labels.length === 0) return answer.choices.length === 0 && Boolean(text);
	if (text && !frame.allowOther) return false;
	return answer.choices.length > 0 || Boolean(text);
}
