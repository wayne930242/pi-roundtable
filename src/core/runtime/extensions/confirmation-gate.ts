import type {
	HeldCall,
	PendingConfirmation,
} from "../../domain/conversation.ts";
import {
	HOLD_DESCRIBE_TIMEOUT_MS,
	type HoldCheck,
	type HoldContext,
	higherTier,
	isPromise,
} from "../../holds.ts";
import { messages } from "../../i18n/index.ts";
import type { OwnerIdentity } from "../../identity.ts";
import type { ApprovedBy, Prompts } from "../../interactions/prompts.ts";
import type { ToolTiers } from "../../tool-tiers.ts";
import { approvalCard, approvalDetails } from "./approval-card.ts";
import { askOnCard } from "./card-ask.ts";
import {
	type AutoApprover,
	approverOf,
	askSpeaker,
	awaitingText,
	declinedText,
	type GateDecision,
	type Needing,
	namesOf,
	type Release,
	remembered,
	type SpeakerRef,
	unlessNamed,
	withdrawn,
} from "./gate-refusals.ts";
import { type Grant, Grants } from "./grants.ts";
import {
	canonicalJson,
	mayApproveNamed,
	namedApprover,
	sameCall,
	spendApproval,
	unexpired,
} from "./held-calls.ts";
import { HoldDescriber } from "./hold-describer.ts";
import { type HoldTurn, type Judgment, STOPPED } from "./hold-lookups.ts";
import { lateOutcome, notifyDeclined } from "./late-answer.ts";

export { confirmationGateExtension } from "./confirmation-gate-extension.ts";
export {
	CONFIRMATION_TTL_MS,
	canonicalJson,
	confirmedTurnText,
	mayApproveNamed,
	namedApprover,
	unexpired,
} from "./held-calls.ts";

import { Withdrawals } from "./withdrawals.ts";

export type { AutoApprover, GateDecision } from "./gate-refusals.ts";
export type { HoldTurn } from "./hold-lookups.ts";

/**
 * Per-channel state of held actions. With the owner's prompts bound, a call that needs their
 * confirmation waits for their answer on a card and runs or is refused in the same turn. Otherwise,
 * or when the card expires, the call is held: it records its tool and exact input, and the
 * owner's next message either confirms them, which lets each identical call run once in that
 * turn, or drops them.
 */
// pi-lens-ignore: large-class — one gate per conversation; its state is the held calls and their approvals
export class ConfirmationGate {
	#selectionId: string | undefined;
	/** The running turn's speaker, whom the actions it holds belong to, and who approves those a message confirmed. */
	#speaker: SpeakerRef | undefined;
	/** Whether the running turn's conversation is private to its speaker, who then alone answers its cards. */
	#private = false;
	/** The running turn's auto-approver, asked before any card opens. */
	#auto: AutoApprover | undefined;
	#pending: PendingConfirmation | undefined;
	#approved: Release[] = [];
	/** Calls approved on their cards after the turn that asked stopped waiting; each runs once, in any turn. */
	#lateApproved: Release[] = [];
	/** Who approved each call that is running, and on which card, by tool call id, until its result is back. */
	readonly #grants = new Grants();
	readonly #holds: HoldCheck;
	readonly #owner: OwnerIdentity;
	/** Whom the running turn's held actions and refusals speak of: the turn's speaker. */
	#addressee: OwnerIdentity;
	readonly #context: HoldContext;
	readonly #tiers: ToolTiers | undefined;
	/** Where the session's relative file paths resolve, for the sizes a card shows. */
	readonly #fileRoot: string | undefined;
	/** The name a principal goes by, for telling a speaker who may approve a call; undefined when unknown. */
	readonly #nameOf:
		| ((principalId: string) => Promise<string | undefined>)
		| undefined;
	/** The held calls a partial release kept, until this turn records a hold of its own. */
	#kept: PendingConfirmation | undefined;
	/** Asks the holds to describe a call in a turn, and hands the answers on in the order they were asked. */
	readonly #describer: HoldDescriber;
	/** The held calls their plugins may still withdraw. */
	readonly #withdrawals = new Withdrawals((call) => this.#forget(call));
	/**
	 * Called with the held actions that remain when a plugin's withdrawal removed one from them,
	 * for whoever keeps them across a restart to keep the smaller set.
	 */
	onHeldChange: ((held: PendingConfirmation | undefined) => void) | undefined;

	/**
	 * `holds` decides which calls wait for the owner. With a workspace, the session has a shell,
	 * and its writes outside the workspace and the context's scratch dir are held too.
	 * `fileRoot` is the session's working directory, where a card resolves relative file paths;
	 * it defaults to the workspace. A hold that looks things up gets `describeTimeoutMs` to answer
	 * (`HOLD_DESCRIBE_TIMEOUT_MS` by default) before its call is held under a generic description.
	 * `nameOf` gives the name of a principal a call names as an approver, which the text a speaker
	 * who cannot approve it is given lists.
	 */
	constructor(
		holds: HoldCheck,
		owner: OwnerIdentity,
		pending?: PendingConfirmation,
		context: HoldContext = {},
		tiers?: ToolTiers,
		fileRoot?: string,
		describeTimeoutMs = HOLD_DESCRIBE_TIMEOUT_MS,
		nameOf?: (principalId: string) => Promise<string | undefined>,
	) {
		this.#describer = new HoldDescriber(holds, context, describeTimeoutMs);
		this.#nameOf = nameOf;
		this.#tiers = tiers;
		this.#fileRoot = fileRoot ?? context.workspace;
		this.#holds = holds;
		this.#owner = owner;
		this.#addressee = owner;
		this.#pending = pending;
		this.#context = context;
	}

	/** Held actions awaiting the owner's answer; expired ones count as none. */
	pending(now = new Date()): PendingConfirmation | undefined {
		return unexpired(this.#pending, now);
	}

	/**
	 * The held calls a message from `speaker` may release: all of them, except those that named
	 * approvers the speaker is neither among nor an owner of, which stay held whoever else asked for
	 * them to run. Undefined when there are none.
	 */
	releasable(speaker?: SpeakerRef): PendingConfirmation | undefined {
		const pending = this.pending();
		if (!pending) return undefined;
		const calls = pending.calls.filter((call) =>
			mayApproveNamed(speaker, call),
		);
		return calls.length === pending.calls.length
			? pending
			: { ...pending, calls };
	}

	/**
	 * `addressee` is who the turn is for; without one, the owner. `speaker` is who spoke the turn,
	 * recorded with what it holds by their id and principal; without one, only the owners may
	 * approve them. When `confirmed`, the speaker's message approved the held calls, and they are
	 * the approver the calls' `run` sees; a call that named approvers is released only when the
	 * speaker is one of them or an owner, and otherwise stays held. `isPrivate` says the turn's
	 * conversation is private to its speaker: they alone then answer its cards. `auto` may approve
	 * a call the turn makes without a card (yolo mode); it does not change a message's approval.
	 */
	beginTurn(
		selectionId: string,
		confirmed: boolean,
		addressee?: OwnerIdentity,
		speaker?: SpeakerRef,
		isPrivate = false,
		auto?: AutoApprover,
	): void {
		this.#selectionId = selectionId;
		this.#speaker = speaker;
		this.#private = isPrivate;
		this.#auto = auto;
		this.#addressee = addressee ?? this.#owner;
		const by = approverOf(speaker);
		const held = this.pending();
		const released = confirmed ? this.releasable(speaker) : undefined;
		this.#approved = (released?.calls ?? []).map((call) => ({
			call,
			...(by ? { by } : {}),
		}));
		// What the speaker could not release stays held for those who may.
		const kept = (held?.calls ?? []).filter(
			(call) => confirmed && !released?.calls.includes(call),
		);
		this.#pending =
			held && kept.length > 0 ? { ...held, calls: kept } : undefined;
		this.#kept = this.#pending;
		this.#sweep();
	}

	endTurn(): void {
		this.#approved = [];
		this.#grants.clear();
		this.#sweep();
	}

	/** How many held calls a plugin may still withdraw. */
	get watching(): number {
		return this.#withdrawals.size;
	}

	/** Stops watching every call, for a gate that is dropped; a card still open is closed by its own surface. */
	abandon(): void {
		this.#withdrawals.clear();
	}

	/** Ends the watches of calls that nothing keeps and no card can answer. */
	#sweep(): void {
		const kept = (call: HeldCall) =>
			(this.#pending?.calls.some((c) => sameCall(c, call)) ?? false) ||
			[...this.#approved, ...this.#lateApproved].some((r) =>
				sameCall(r.call, call),
			);
		this.#withdrawals.sweep(kept);
	}

	/** A plugin withdrew `call`: nothing that could run it stays, and what is held is kept anew. */
	#forget(call: HeldCall): void {
		const other = (r: { call: HeldCall }) => !sameCall(r.call, call);
		this.#approved = this.#approved.filter(other);
		this.#lateApproved = this.#lateApproved.filter(other);
		const pending = this.#pending;
		if (!pending?.calls.some((c) => sameCall(c, call))) return;
		// In place, so a partial release's kept set stays the object `remembered` compares.
		pending.calls = pending.calls.filter((c) => !sameCall(c, call));
		if (pending.calls.length === 0) {
			this.#pending = undefined;
			if (this.#kept === pending) this.#kept = undefined;
		}
		this.onHeldChange?.(this.pending());
	}

	/** Who approved the held call running under this tool call id; undefined when it was not held or they are unknown. */
	approvedBy(toolCallId: string): ApprovedBy | undefined {
		return this.#grants.get(toolCallId)?.by;
	}

	/** The id of the card that approved the call running under this tool call id; undefined when no card did. */
	approvedPrompt(toolCallId: string): string | undefined {
		return this.#grants.get(toolCallId)?.prompt;
	}

	/** Notes who approved the call running under a tool call id, and on which card, for its `run` to read. */
	grant(toolCallId: string, grant: Grant): void {
		this.#grants.set(toolCallId, grant);
	}

	/** Forgets who approved a tool call, once its result is back. */
	finish(toolCallId: string): void {
		this.#grants.delete(toolCallId);
	}

	/** Returns the reason a call is held, or undefined to let it run. */
	hold(tool: string, input: Record<string, unknown>): string | undefined {
		const needing = this.#needing(tool, input);
		return needing && "held" in needing
			? this.#record(needing.held)
			: undefined;
	}

	/**
	 * Like `hold`, but asks the owner on a card first when `prompts` is given: their approval runs
	 * the call, their refusal blocks it, and only an expired card holds it.
	 */
	async review(
		tool: string,
		input: Record<string, unknown>,
		ask?: { prompts: Prompts; asker: string; signal?: AbortSignal },
		turn?: HoldTurn,
	): Promise<string | undefined> {
		return (await this.decide(tool, input, ask, turn)).reason;
	}

	/**
	 * `review`, plus whether a card's approval released the call, so its result can say so:
	 * the card's own message is shown to the person, never to the model. When a hold refuses the
	 * call, `refused` says how, for the turn's progress to report beside the failed result.
	 * With `turn`, a hold that looks things up as the turn's speaker is waited for before any card
	 * opens, and a turn that stops meanwhile opens none. The tool's JSON Schema, as `parameters`,
	 * has the card show the call as fields.
	 */
	async decide(
		tool: string,
		input: Record<string, unknown>,
		ask?: { prompts: Prompts; asker: string; signal?: AbortSignal },
		turn?: HoldTurn,
		parameters?: unknown,
	): Promise<GateDecision> {
		const found = this.#needingIn(tool, input, turn);
		const needing = isPromise(found) ? await found : found;
		if (needing === STOPPED) return { reason: "The turn was stopped." };
		if (!needing) return {};
		if ("released" in needing) {
			const { by, prompt } = needing.released;
			return {
				...(by ? { approvedBy: by } : {}),
				...(prompt ? { approvedPrompt: prompt } : {}),
			};
		}
		const call = needing.held;
		const watch = needing.supersede
			? this.#withdrawals.watch(call, needing.supersede)
			: undefined;
		if (watch?.withdrawn) return withdrawn(call);
		/** Holds the call for a message, no card being open for it. */
		const held = async (refused: "held" | "expired") => {
			// A withdrawn call is never held again, whatever the card said last.
			if (watch?.withdrawn) return withdrawn(call);
			if (watch) watch.card = false;
			return { reason: await this.#held(call), refused };
		};
		// Outside a turn there is no speaker whose conversation could be in yolo mode.
		const auto = turn
			? this.#auto?.(call, { speakerOnly: needing.speakerOnly === true })
			: undefined;
		if (auto) {
			watch?.end();
			return { approvedBy: auto };
		}
		if (!ask) return held("held");
		// In a private conversation only its person answers: a call that names others is not theirs.
		if (this.#private && !mayApproveNamed(this.#speaker, call))
			return held("held");
		const { answer, approvedBy, approvedPrompt } = await askOnCard(
			ask.prompts,
			{
				title: messages().confirmTitle(ask.asker),
				message: approvalCard(call, this.#fileRoot, {}, parameters),
				signal: ask.signal,
				minTier: higherTier(this.#tiers?.minTier(call.tool), call.minTier),
				wait: {
					// A late answer on the card: the text of the turn that tells the model, and the release it earned.
					late: (late) => {
						const outcome = lateOutcome(call, late, watch);
						if (outcome?.release) this.#lateApproved.push(outcome.release);
						if (outcome?.declined) notifyDeclined(needing.onDeclined);
						return outcome?.text;
					},
				},
				details: approvalDetails(call, this.#fileRoot, needing.copy),
				approvers: call.approverIds,
				speakerOnly: needing.speakerOnly === true,
				watch,
			},
		);
		// Whatever the card then reports, a call the plugin withdrew is refused, never held again.
		if (answer === "withdrawn" || (watch?.withdrawn && answer !== "approved"))
			return withdrawn(call);
		if (answer === "approved") {
			// A private conversation's answer to a call that names approvers is its person's, whom a surface need not name.
			const by =
				approvedBy ??
				(this.#private && call.approverIds
					? approverOf(this.#speaker)
					: undefined);
			// A call that names approvers runs only on the word of one of them, or an owner.
			if (!namedApprover(call, by)) return held("held");
			watch?.end();
			return {
				approvedOnCard: true,
				...(by ? { approvedBy: by } : {}),
				...(approvedPrompt ? { approvedPrompt } : {}),
			};
		}
		if (answer === "pending")
			return {
				reason: awaitingText(this.#addressee, call),
				refused: "pending",
			};
		if (answer === "declined") {
			notifyDeclined(needing.onDeclined);
			watch?.end();
			return {
				reason: declinedText(this.#addressee, call),
				refused: "declined",
			};
		}
		if (answer === "cancelled") {
			watch?.end();
			return { reason: "The turn was stopped." };
		}
		// No card was shown, or it went unanswered: the call is held for a message, and stays withdrawable.
		return held(answer === "unavailable" ? "held" : "expired");
	}

	/** What a call needs when a rule holds it; undefined when none does. */
	#needing(tool: string, input: Record<string, unknown>): Needing | undefined {
		const action = this.#holds(tool, input, this.#context);
		if (!action) return undefined;
		const classes = this.#holds.classesOf?.(tool, input, this.#context);
		return this.#unlessApproved(tool, input, { action, classes });
	}

	/**
	 * `#needing` inside a turn, where a hold may look things up first: the call when it needs the
	 * owner's confirmation, or `STOPPED` when the turn stopped while its description was awaited.
	 * It answers at once when every hold asked does and no earlier call is still being described.
	 */
	#needingIn(
		tool: string,
		input: Record<string, unknown>,
		turn: HoldTurn | undefined,
	):
		| Needing
		| undefined
		| typeof STOPPED
		| Promise<Needing | undefined | typeof STOPPED> {
		if (!turn || !this.#holds.inTurn) return this.#needing(tool, input);
		return this.#describer.describe(tool, input, turn, (judged) => {
			if (judged === STOPPED) return STOPPED;
			return judged ? this.#unlessApproved(tool, input, judged) : undefined;
		});
	}

	/**
	 * The call for a description, unless an approval releases it, which that approval then spends
	 * and whose approver the release names.
	 */
	#unlessApproved(
		tool: string,
		input: Record<string, unknown>,
		judged: Judgment,
	): Needing {
		const minTier = this.#holds.approvalTier?.(tool, input, this.#context);
		const call: HeldCall = {
			tool,
			input: canonicalJson(input),
			action: judged.action,
			...(minTier ? { minTier } : {}),
			...(judged.approvers ? { approverIds: [...judged.approvers] } : {}),
			...(judged.classes && judged.classes.length > 0
				? { holdClasses: [...judged.classes] }
				: {}),
		};
		// A plugin that already withdrew the call lets no approval of it release it.
		const spent = judged.supersede?.aborted
			? undefined
			: spendApproval([this.#approved, this.#lateApproved], call);
		if (spent) {
			this.#withdrawals.endCall(spent.call);
			return { released: spent };
		}
		return {
			held: call,
			...(judged.copy ? { copy: judged.copy } : {}),
			...(judged.supersede ? { supersede: judged.supersede } : {}),
			...(judged.speakerOnly ? { speakerOnly: judged.speakerOnly } : {}),
			...(judged.onDeclined ? { onDeclined: judged.onDeclined } : {}),
		};
	}

	/** Records the call as held and returns what the model is told about it. */
	#record(call: HeldCall): string {
		this.#remember(call);
		const refusal = unlessNamed(
			call,
			this.#speaker,
			this.#addressee,
			this.#private,
		);
		return refusal ? refusal([], false) : askSpeaker(this.#addressee, call);
	}

	/**
	 * `#record` for a call that names approvers the speaker is not among: the text then lists who
	 * may approve it, which looks their names up first.
	 */
	async #held(call: HeldCall): Promise<string> {
		this.#remember(call);
		const refusal = unlessNamed(
			call,
			this.#speaker,
			this.#addressee,
			this.#private,
		);
		if (!refusal) return askSpeaker(this.#addressee, call);
		const { names, missing } = await namesOf(
			this.#nameOf,
			call.approverIds ?? [],
		);
		return refusal(names, missing);
	}

	#remember(call: HeldCall): void {
		const selectionId = this.#selectionId;
		if (selectionId === undefined)
			throw new Error("a call was held outside a turn");
		this.#pending = remembered(
			this.#pending,
			this.#kept,
			selectionId,
			this.#speaker,
			call,
		);
		this.#kept = undefined;
	}
}
