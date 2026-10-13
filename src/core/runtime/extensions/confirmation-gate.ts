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
import {
	canonicalJson,
	mayApproveNamed,
	namedApprover,
	unexpired,
} from "./held-calls.ts";
import {
	awaited,
	type Described,
	type HoldTurn,
	joinApprovers,
	STOPPED,
} from "./hold-lookups.ts";

export { confirmationGateExtension } from "./confirmation-gate-extension.ts";
export {
	CONFIRMATION_TTL_MS,
	canonicalJson,
	confirmedTurnText,
	mayApproveNamed,
	namedApprover,
	unexpired,
} from "./held-calls.ts";
export type { HoldTurn } from "./hold-lookups.ts";

/**
 * The speaker of a turn as the gate records them; `name` is what an approval by their message is
 * attributed to, and `tier` tells whether they approve as an owner.
 */
type SpeakerRef = Pick<Speaker, "id" | "principalId"> & {
	name?: string;
	tier?: Speaker["tier"];
};

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
	/** Whether the running turn's conversation is private to its speaker, who then alone answers its cards. */
	#private = false;
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
	/** The name a principal goes by, for telling a speaker who may approve a call; undefined when unknown. */
	readonly #nameOf:
		| ((principalId: string) => Promise<string | undefined>)
		| undefined;
	/** The held calls a partial release kept, until this turn records a hold of its own. */
	#kept: PendingConfirmation | undefined;
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
		this.#describeTimeoutMs = describeTimeoutMs;
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
	 * conversation is private to its speaker: they alone then answer its cards.
	 */
	beginTurn(
		selectionId: string,
		confirmed: boolean,
		addressee?: OwnerIdentity,
		speaker?: SpeakerRef,
		isPrivate = false,
	): void {
		this.#selectionId = selectionId;
		this.#speaker = speaker;
		this.#private = isPrivate;
		this.#addressee = addressee ?? this.#owner;
		const by: ApprovedBy | undefined = speaker
			? {
					principalId: speaker.principalId,
					speakerId: speaker.id,
					name: speaker.name ?? speaker.id,
					...(speaker.tier === "owner" ? { owner: true as const } : {}),
				}
			: undefined;
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
	}

	endTurn(): void {
		this.#approved = [];
		this.#approvers.clear();
	}

	/** The running turn's speaker as an approver; undefined without one. */
	#speakerAsApprover(): ApprovedBy | undefined {
		const speaker = this.#speaker;
		if (!speaker) return undefined;
		return {
			principalId: speaker.principalId,
			speakerId: speaker.id,
			name: speaker.name ?? speaker.id,
			...(speaker.tier === "owner" ? { owner: true as const } : {}),
		};
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
		if (!ask) return { reason: await this.#held(call), refused: "held" };
		// In a private conversation only its person answers: a call that names others is not theirs.
		if (this.#private && !mayApproveNamed(this.#speaker, call))
			return { reason: await this.#held(call), refused: "held" };
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
		if (answer === "approved") {
			// A private conversation's answer to a call that names approvers is its person's, whom a surface need not name.
			const by =
				approvedBy ??
				(this.#private && call.approverIds
					? this.#speakerAsApprover()
					: undefined);
			// A call that names approvers runs only on the word of one of them, or an owner.
			if (!namedApprover(call, by))
				return { reason: await this.#held(call), refused: "held" };
			return { approvedOnCard: true, ...(by ? { approvedBy: by } : {}) };
		}
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
			return { reason: await this.#held(call), refused: "held" };
		return { reason: await this.#held(call), refused: "expired" };
	}

	/**
	 * A late answer on a call's card: an approval lets the identical call run once, in whichever
	 * turn makes it next; returns the text of the turn that tells the model.
	 */
	#late(call: HeldCall, late: LateAnswer): string | undefined {
		if (late.kind !== "approval") return undefined;
		if (late.approved && !namedApprover(call, late.approvedBy))
			return undefined;
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
			? awaited(
					answer,
					messages().holdGeneric(tool),
					controller,
					turn.signal,
					this.#describeTimeoutMs,
				)
			: answer;
		return this.#inOrder(
			joinApprovers(
				described,
				{
					holds: this.#holds,
					context: this.#context,
					timeoutMs: this.#describeTimeoutMs,
				},
				tool,
				input,
				turn,
			),
			(judged) => {
				if (judged === STOPPED) return STOPPED;
				return judged ? this.#unlessApproved(tool, input, judged) : undefined;
			},
		);
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

	/** Records the call as held and returns what the model is told about it. */
	#record(call: HeldCall): string {
		this.#remember(call);
		const refusal = this.#unlessNamed(call);
		return refusal ? refusal([], false) : this.#askSpeaker(call);
	}

	/**
	 * `#record` for a call that names approvers the speaker is not among: the text then lists who
	 * may approve it, which looks their names up first.
	 */
	async #held(call: HeldCall): Promise<string> {
		this.#remember(call);
		const refusal = this.#unlessNamed(call);
		if (!refusal) return this.#askSpeaker(call);
		const { names, missing } = await this.#namesOf(call.approverIds ?? []);
		return refusal(names, missing);
	}

	#remember(call: HeldCall): void {
		const selectionId = this.#selectionId;
		if (selectionId === undefined)
			throw new Error("a call was held outside a turn");
		let pending = this.#pending;
		// A partial release kept calls that name approvers, which belong to no speaker: what this turn
		// holds is its speaker's, from now.
		if (pending && pending === this.#kept) {
			pending = { ...pending, calls: [...pending.calls] };
			pending.selectionId = selectionId;
			pending.heldAt = new Date();
			delete pending.speakerId;
			delete pending.principalId;
			if (this.#speaker) {
				pending.speakerId = this.#speaker.id;
				pending.principalId = this.#speaker.principalId;
			}
		}
		this.#kept = undefined;
		pending ??= {
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
	}

	/** The text for a held call that the speaker's own message confirms. */
	#askSpeaker(call: HeldCall): string {
		const o = ownerWords(this.#addressee);
		return `Held for ${o.name}'s confirmation: this would ${call.action}. Do not retry it in this turn. Tell ${o.him} exactly what will happen and ask ${o.him} to confirm; once ${o.he} agrees in ${o.his} next message, make the same call with the same input and it runs.`;
	}

	/**
	 * For a call that names approvers the speaker is neither among nor an owner of: the text that
	 * tells the model the truth about it, from the names of those who may approve; undefined when
	 * the speaker may.
	 */
	#unlessNamed(
		call: HeldCall,
	): ((names: string[], missing: boolean) => string) | undefined {
		if (!call.approverIds || mayApproveNamed(this.#speaker, call))
			return undefined;
		const o = ownerWords(this.#addressee);
		const anyone = (call.approverIds?.length ?? 0) > 0;
		return (names, missing) => {
			// Names that could not be read still leave the people the tool named.
			const named =
				names.length === 0 && anyone
					? ["the people named for it"]
					: missing
						? [...names, "others named for it"]
						: names;
			const who = orList([...named, "an owner"]);
			const approval = `Only ${who} can approve it.`;
			if (this.#private)
				return `Held, and ${o.name} cannot approve it here: this would ${call.action}. ${approval} A private conversation can only be answered by its person, so it stays held and nothing ${o.he} says here releases it. Do not retry it, and do not ask ${o.him} to confirm it or to say yes. Tell ${o.him} plainly that it was not done and needs ${who}.`;
			return `Held, and ${o.name} cannot approve it: this would ${call.action}. ${approval} Do not retry it in this turn, and do not ask ${o.name} to confirm it. Tell ${o.him} plainly that it was not done, and ask ${who} to confirm in this channel; once one of them agrees in a message, make the same call with the same input and it runs.`;
		};
	}

	/** The names of the principals, as far as they are known; ids are never shown. `missing` says some could not be read. */
	async #namesOf(
		principalIds: readonly string[],
	): Promise<{ names: string[]; missing: boolean }> {
		const nameOf = this.#nameOf;
		if (!nameOf) return { names: [], missing: principalIds.length > 0 };
		const names = await Promise.all(
			[...new Set(principalIds)].map(async (id) => {
				try {
					return await nameOf(id);
				} catch {
					return undefined;
				}
			}),
		);
		return {
			names: [...new Set(names.filter((name): name is string => !!name))],
			missing: names.some((name) => !name),
		};
	}
}

/** "a", "a or b", "a, b or c". */
function orList(items: readonly string[]): string {
	const last = items.at(-1);
	if (items.length < 2 || last === undefined) return items.join("");
	return `${items.slice(0, -1).join(", ")} or ${last}`;
}
