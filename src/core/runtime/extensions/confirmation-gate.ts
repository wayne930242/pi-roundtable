import type { ToolTurn } from "../../define.ts";
import type {
	HeldCall,
	PendingConfirmation,
} from "../../domain/conversation.ts";
import type { HoldRefusal } from "../../domain/progress.ts";
import {
	HOLD_DESCRIBE_TIMEOUT_MS,
	type HoldCheck,
	type HoldContext,
	higherTier,
	isPromise,
} from "../../holds.ts";
import { messages } from "../../i18n/index.ts";
import { type OwnerIdentity, ownerWords } from "../../identity.ts";
import type {
	ApprovalOptions,
	ApprovedBy,
	LateAnswer,
	Prompts,
} from "../../interactions/prompts.ts";
import type { Speaker } from "../../speakers.ts";
import type { ToolTiers } from "../../tool-tiers.ts";
import { approvalCard, approvalDetails } from "./approval-card.ts";
import { canonicalJson, unexpired } from "./held-calls.ts";

export { confirmationGateExtension } from "./confirmation-gate-extension.ts";
export {
	CONFIRMATION_TTL_MS,
	canonicalJson,
	confirmedTurnText,
	unexpired,
} from "./held-calls.ts";

/** The turn a hold that looks things up sees; see `HoldRule.describeInTurn`. */
export interface HoldTurn {
	/** Aborts when the turn stops; a call being described then opens no card. */
	signal?: AbortSignal;
	/** The turn a hold receives, with `signal` as the signal that ends its wait. */
	toolTurn(signal: AbortSignal): ToolTurn;
}

/** The answer of a description wait the turn's stop cut short. */
const STOPPED = Symbol("stopped");

/** What waiting for a call's description comes to: its text, or the turn stopped first. */
type Described = string | undefined | typeof STOPPED;

/** A held call's description with who may approve it instead of the speaker; see `HoldRule.approversInTurn`. */
type Judged =
	| { action: string; approvers?: readonly string[] }
	| undefined
	| typeof STOPPED;

/** The speaker of a turn as the gate records them; `name` is what an approval by their message is attributed to. */
type SpeakerRef = Pick<Speaker, "id" | "principalId"> & { name?: string };

/** A call an approval released, and who gave it, when that is known. */
interface Release {
	call: HeldCall;
	by?: ApprovedBy;
}

/** What a call needs of the gate: nothing, a hold, or a release that spends an approval. */
type Needing = { held: HeldCall } | { released: ApprovedBy | undefined };

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
	#pending: PendingConfirmation | undefined;
	#approved: Release[] = [];
	/** Calls approved on their cards after the turn that asked stopped waiting; each runs once, in any turn. */
	#lateApproved: Release[] = [];
	/** Who approved each call that is running, by tool call id, until its result is back. */
	readonly #approvers = new Map<string, ApprovedBy>();
	readonly #holds: HoldCheck;
	readonly #owner: OwnerIdentity;
	/** Whom the running turn's held actions and refusals speak of: the turn's speaker. */
	#addressee: OwnerIdentity;
	readonly #context: HoldContext;
	readonly #tiers: ToolTiers | undefined;
	/** Where the session's relative file paths resolve, for the sizes a card shows. */
	readonly #fileRoot: string | undefined;
	readonly #describeTimeoutMs: number;
	/** Settles when the descriptions asked for so far have all been used, in the order they were asked. */
	#describing: Promise<void> = Promise.resolve();
	/** Descriptions asked for and not used yet. */
	#undescribed = 0;

	/**
	 * `holds` decides which calls wait for the owner. With a workspace, the session has a shell,
	 * and its writes outside the workspace and the context's scratch dir are held too.
	 * `fileRoot` is the session's working directory, where a card resolves relative file paths;
	 * it defaults to the workspace. A hold that looks things up gets `describeTimeoutMs` to answer
	 * (`HOLD_DESCRIBE_TIMEOUT_MS` by default) before its call is held under a generic description.
	 */
	constructor(
		holds: HoldCheck,
		owner: OwnerIdentity,
		pending?: PendingConfirmation,
		context: HoldContext = {},
		tiers?: ToolTiers,
		fileRoot?: string,
		describeTimeoutMs = HOLD_DESCRIBE_TIMEOUT_MS,
	) {
		this.#describeTimeoutMs = describeTimeoutMs;
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
	 * `addressee` is who the turn is for; without one, the owner. `speaker` is who spoke the turn,
	 * recorded with what it holds by their id and principal; without one, only the owners may
	 * approve them. When `confirmed`, the speaker's message approved the held calls, and they are
	 * the approver the calls' `run` sees.
	 */
	beginTurn(
		selectionId: string,
		confirmed: boolean,
		addressee?: OwnerIdentity,
		speaker?: SpeakerRef,
	): void {
		this.#selectionId = selectionId;
		this.#speaker = speaker;
		this.#addressee = addressee ?? this.#owner;
		const by = speaker
			? {
					principalId: speaker.principalId,
					speakerId: speaker.id,
					name: speaker.name ?? speaker.id,
				}
			: undefined;
		this.#approved = confirmed
			? (this.pending()?.calls ?? []).map((call) => ({
					call,
					...(by ? { by } : {}),
				}))
			: [];
		this.#pending = undefined;
	}

	endTurn(): void {
		this.#approved = [];
		this.#approvers.clear();
	}

	/** Who approved the held call running under this tool call id; undefined when it was not held or they are unknown. */
	approvedBy(toolCallId: string): ApprovedBy | undefined {
		return this.#approvers.get(toolCallId);
	}

	/** Notes who approved the call running under a tool call id, for its `run` to read. */
	grant(toolCallId: string, by: ApprovedBy): void {
		this.#approvers.set(toolCallId, by);
	}

	/** Forgets who approved a tool call, once its result is back. */
	finish(toolCallId: string): void {
		this.#approvers.delete(toolCallId);
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
	 * opens, and a turn that stops meanwhile opens none.
	 */
	async decide(
		tool: string,
		input: Record<string, unknown>,
		ask?: { prompts: Prompts; asker: string; signal?: AbortSignal },
		turn?: HoldTurn,
	): Promise<{
		reason?: string;
		approvedOnCard?: true;
		/** Who approved the call, when it was held and a surface or a confirming message said who. */
		approvedBy?: ApprovedBy;
		/** Why a hold refused the call, for a surface that tells that from a failure; absent when it ran or the turn stopped. */
		refused?: HoldRefusal;
	}> {
		const found = this.#needingIn(tool, input, turn);
		const needing = isPromise(found) ? await found : found;
		if (needing === STOPPED) return { reason: "The turn was stopped." };
		if (!needing) return {};
		if ("released" in needing)
			return needing.released ? { approvedBy: needing.released } : {};
		const call = needing.held;
		if (!ask) return { reason: this.#record(call), refused: "held" };
		let approvedBy: ApprovedBy | undefined;
		const options: ApprovalOptions = {
			...(call.approverIds ? { approvers: call.approverIds } : {}),
			approvedBy: (by) => {
				approvedBy = by;
			},
		};
		const answer = await ask.prompts.confirm(
			messages().confirmTitle(ask.asker),
			approvalCard(call, this.#fileRoot),
			ask.signal,
			higherTier(this.#tiers?.minTier(call.tool), call.minTier),
			{ late: (late) => this.#late(call, late) },
			approvalDetails(call, this.#fileRoot),
			options,
		);
		if (answer === "approved")
			return { approvedOnCard: true, ...(approvedBy ? { approvedBy } : {}) };
		if (answer === "pending") {
			const o = ownerWords(this.#addressee);
			return {
				reason: `Awaiting ${o.name}'s approval: this would ${call.action}. Its card stays open, and the call did not run. Do not retry it or ask again in this turn. End your turn now: say briefly that you are waiting for ${o.his} approval on the card. When ${o.he} answers, a new turn tells you.`,
				refused: "pending",
			};
		}
		if (answer === "declined") {
			const o = ownerWords(this.#addressee);
			return {
				reason: `${o.name} declined this on its approval card: it would ${call.action}. Do not retry it; go on without it, or ask ${o.him} what ${o.he} wants instead.`,
				refused: "declined",
			};
		}
		if (answer === "cancelled") return { reason: "The turn was stopped." };
		// No card was shown: no one may approve it, or it could not be posted.
		if (answer === "unavailable")
			return { reason: this.#record(call), refused: "held" };
		return { reason: this.#record(call), refused: "expired" };
	}

	/**
	 * A late answer on a call's card: an approval lets the identical call run once, in whichever
	 * turn makes it next; returns the text of the turn that tells the model.
	 */
	#late(call: HeldCall, late: LateAnswer): string | undefined {
		if (late.kind !== "approval") return undefined;
		if (!late.approved)
			return `(${late.by} declined on its card the action you were waiting on: it would ${call.action}. It did not run; do not make the call again. Go on without it, or ask what ${late.by} wants instead.)`;
		this.#lateApproved.push({
			call,
			...(late.approvedBy ? { by: late.approvedBy } : {}),
		});
		return `(${late.by} approved on its card the action you were waiting on: it would ${call.action}. Make this call now with exactly this input, and it runs once; then report its result.)\n- ${call.tool} ${call.input}`;
	}

	/** What a call needs when a rule holds it; undefined when none does. */
	#needing(tool: string, input: Record<string, unknown>): Needing | undefined {
		const action = this.#holds(tool, input, this.#context);
		return action ? this.#unlessApproved(tool, input, { action }) : undefined;
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
		const inTurn = this.#holds.inTurn;
		if (!turn || !inTurn) return this.#needing(tool, input);
		const controller = new AbortController();
		if (turn.signal?.aborted) controller.abort();
		let answer: string | undefined | Promise<string | undefined>;
		try {
			answer = inTurn.call(
				this.#holds,
				tool,
				input,
				this.#context,
				turn.toolTurn(controller.signal),
			);
		} catch {
			answer = messages().holdGeneric(tool);
		}
		const described: Described | Promise<Described> = isPromise(answer)
			? this.#awaited(
					answer,
					messages().holdGeneric(tool),
					controller,
					turn.signal,
				)
			: answer;
		return this.#inOrder(
			this.#judged(described, tool, input, turn),
			(judged) => {
				if (judged === STOPPED) return STOPPED;
				return judged ? this.#unlessApproved(tool, input, judged) : undefined;
			},
		);
	}

	/**
	 * A description joined by the approvers the holds name for a call they hold, looked up as the
	 * turn with the same wait as the description; a lookup that rejects or outlasts the timeout names
	 * none, so only the owners approve the call. A call no rule holds asks no one.
	 */
	#judged(
		described: Described | Promise<Described>,
		tool: string,
		input: Record<string, unknown>,
		turn: HoldTurn,
	): Judged | Promise<Judged> {
		const lookup = this.#holds.approversInTurn;
		if (!lookup) return this.#withoutApprovers(described);
		const join = (action: Described): Judged | Promise<Judged> => {
			if (action === STOPPED || action === undefined) return action;
			const controller = new AbortController();
			if (turn.signal?.aborted) controller.abort();
			let named:
				| readonly string[]
				| undefined
				| Promise<readonly string[] | undefined>;
			try {
				named = lookup.call(
					this.#holds,
					tool,
					input,
					this.#context,
					turn.toolTurn(controller.signal),
				);
			} catch {
				named = [];
			}
			if (!isPromise(named)) {
				controller.abort();
				return named ? { action, approvers: named } : { action };
			}
			return this.#awaited(named, [], controller, turn.signal).then(
				(approvers) => {
					if (approvers === STOPPED) return STOPPED;
					return approvers ? { action, approvers } : { action };
				},
			);
		};
		return isPromise(described) ? described.then(join) : join(described);
	}

	#withoutApprovers(
		described: Described | Promise<Described>,
	): Judged | Promise<Judged> {
		const wrap = (action: Described): Judged =>
			action === STOPPED || action === undefined ? action : { action };
		return isPromise(described) ? described.then(wrap) : wrap(described);
	}

	/**
	 * What a lookup that answers later comes to: its answer; `fallback` when it rejects or outlasts
	 * the timeout; `STOPPED` when the turn stops first. Whatever the lookup is still doing is
	 * aborted when the wait ends.
	 */
	#awaited<T>(
		answer: Promise<T>,
		fallback: T,
		lookup: AbortController,
		stop: AbortSignal | undefined,
	): Promise<T | typeof STOPPED> {
		return new Promise((resolve) => {
			const onStop = () => end(STOPPED);
			const timer = setTimeout(() => end(fallback), this.#describeTimeoutMs);
			let ended = false;
			const end = (found: T | typeof STOPPED) => {
				if (ended) return;
				ended = true;
				clearTimeout(timer);
				stop?.removeEventListener("abort", onStop);
				lookup.abort();
				resolve(found);
			};
			// Handled first, so a rejection after the wait ended is never left unhandled.
			answer.then(end, () => end(fallback));
			if (stop?.aborted) return end(STOPPED);
			stop?.addEventListener("abort", onStop, { once: true });
		});
	}

	/**
	 * Hands `described` to `use` after every description asked for before it has been used, so
	 * calls made together are held, and their cards opened, in the order they were made whichever
	 * description comes back first.
	 */
	#inOrder<T, R>(
		described: T | Promise<T>,
		use: (described: T) => R,
	): R | Promise<R> {
		if (this.#undescribed === 0 && !isPromise(described)) return use(described);
		this.#undescribed++;
		const used = this.#describing.then(() => described).then(use);
		this.#describing = used.then(
			() => {
				this.#undescribed--;
			},
			() => {
				this.#undescribed--;
			},
		);
		return used;
	}

	/**
	 * The call for a description, unless an approval releases it, which that approval then spends
	 * and whose approver the release names.
	 */
	#unlessApproved(
		tool: string,
		input: Record<string, unknown>,
		judged: { action: string; approvers?: readonly string[] },
	): Needing {
		const minTier = this.#holds.approvalTier?.(tool, input, this.#context);
		const call: HeldCall = {
			tool,
			input: canonicalJson(input),
			action: judged.action,
			...(minTier ? { minTier } : {}),
			...(judged.approvers ? { approverIds: [...judged.approvers] } : {}),
		};
		for (const released of [this.#approved, this.#lateApproved]) {
			const approved = released.findIndex(
				(r) => r.call.tool === call.tool && r.call.input === call.input,
			);
			const [spent] = approved === -1 ? [] : released.splice(approved, 1);
			if (spent) return { released: spent.by };
		}
		return { held: call };
	}

	#record(call: HeldCall): string {
		const selectionId = this.#selectionId;
		if (selectionId === undefined)
			throw new Error("a call was held outside a turn");
		const pending: PendingConfirmation = this.#pending ?? {
			selectionId,
			heldAt: new Date(),
			calls: [],
			...(this.#speaker
				? {
						speakerId: this.#speaker.id,
						principalId: this.#speaker.principalId,
					}
				: {}),
		};
		if (
			!pending.calls.some((c) => c.tool === call.tool && c.input === call.input)
		)
			pending.calls.push(call);
		this.#pending = pending;
		const o = ownerWords(this.#addressee);
		return `Held for ${o.name}'s confirmation: this would ${call.action}. Do not retry it in this turn. Tell ${o.him} exactly what will happen and ask ${o.him} to confirm; once ${o.he} agrees in ${o.his} next message, make the same call with the same input and it runs.`;
	}
}
