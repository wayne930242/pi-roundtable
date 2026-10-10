import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
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
import type { LateAnswer, Prompts } from "../../interactions/prompts.ts";
import type { Speaker } from "../../speakers.ts";
import type { ToolTiers } from "../../tool-tiers.ts";
import type { PromptSlot } from "../prompt-slot.ts";
import { approvalCard, approvalDetails } from "./approval-card.ts";

/** Held actions older than this cannot be approved any more. */
export const CONFIRMATION_TTL_MS = 24 * 3_600_000;

/** The held actions when they can still be approved at `now`; expired ones count as none. */
export function unexpired(
	pending: PendingConfirmation | undefined,
	now = new Date(),
): PendingConfirmation | undefined {
	if (!pending) return undefined;
	return now.getTime() - pending.heldAt.getTime() > CONFIRMATION_TTL_MS
		? undefined
		: pending;
}

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

/** JSON with object keys sorted at every level, so equal inputs compare equal. */
// pi-lens-ignore: no-unknown-parameters — tool input is untyped model JSON; this is where it is read
export function canonicalJson(value: unknown): string {
	// pi-lens-ignore: no-unknown-parameters — tool input is untyped model JSON; this is where it is read
	return JSON.stringify(value, (_key, v: unknown) =>
		isPlainObject(v) ? withSortedKeys(v) : v,
	);
}

// pi-lens-ignore: no-unknown-parameters — tool input is untyped model JSON; this is where it is read
function isPlainObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** The same object with its keys in code-unit order. */
function withSortedKeys(
	value: Record<string, unknown>,
): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(value).sort(([a], [b]) => byCodeUnit(a, b)),
	);
}

function byCodeUnit(a: string, b: string): number {
	if (a < b) return -1;
	return a > b ? 1 : 0;
}

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
	/** The running turn's speaker, whom the actions it holds belong to. */
	#speaker: Pick<Speaker, "id" | "principalId"> | undefined;
	#pending: PendingConfirmation | undefined;
	#approved: HeldCall[] = [];
	/** Calls approved on their cards after the turn that asked stopped waiting; each runs once, in any turn. */
	#lateApproved: HeldCall[] = [];
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
	 * approve them.
	 */
	beginTurn(
		selectionId: string,
		confirmed: boolean,
		addressee?: OwnerIdentity,
		speaker?: Pick<Speaker, "id" | "principalId">,
	): void {
		this.#selectionId = selectionId;
		this.#speaker = speaker;
		this.#addressee = addressee ?? this.#owner;
		this.#approved = confirmed ? [...(this.pending()?.calls ?? [])] : [];
		this.#pending = undefined;
	}

	endTurn(): void {
		this.#approved = [];
	}

	/** Returns the reason a call is held, or undefined to let it run. */
	hold(tool: string, input: Record<string, unknown>): string | undefined {
		const call = this.#needing(tool, input);
		return call ? this.#record(call) : undefined;
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
		/** Why a hold refused the call, for a surface that tells that from a failure; absent when it ran or the turn stopped. */
		refused?: HoldRefusal;
	}> {
		const found = this.#needingIn(tool, input, turn);
		const call = isPromise(found) ? await found : found;
		if (call === STOPPED) return { reason: "The turn was stopped." };
		if (!call) return {};
		if (!ask) return { reason: this.#record(call), refused: "held" };
		const answer = await ask.prompts.confirm(
			messages().confirmTitle(ask.asker),
			approvalCard(call, this.#fileRoot),
			ask.signal,
			higherTier(this.#tiers?.minTier(call.tool), call.minTier),
			{ late: (late) => this.#late(call, late) },
			approvalDetails(call, this.#fileRoot),
		);
		if (answer === "approved") return { approvedOnCard: true };
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
		this.#lateApproved.push(call);
		return `(${late.by} approved on its card the action you were waiting on: it would ${call.action}. Make this call now with exactly this input, and it runs once; then report its result.)\n- ${call.tool} ${call.input}`;
	}

	/** The call when it needs the owner's confirmation and no approval releases it. */
	#needing(tool: string, input: Record<string, unknown>): HeldCall | undefined {
		const action = this.#holds(tool, input, this.#context);
		return action ? this.#unlessApproved(tool, input, action) : undefined;
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
		| HeldCall
		| undefined
		| typeof STOPPED
		| Promise<HeldCall | undefined | typeof STOPPED> {
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
			? this.#awaited(answer, tool, controller, turn.signal)
			: answer;
		return this.#inOrder(described, (action) => {
			if (action === STOPPED) return STOPPED;
			return action ? this.#unlessApproved(tool, input, action) : undefined;
		});
	}

	/**
	 * What a hold that answers later comes to: its text; the generic description when it rejects or
	 * outlasts the timeout, so the call is still held; `STOPPED` when the turn stops first. Whatever
	 * the hold is still doing is aborted when the wait ends.
	 */
	#awaited(
		answer: Promise<string | undefined>,
		tool: string,
		hold: AbortController,
		stop: AbortSignal | undefined,
	): Promise<Described> {
		return new Promise<Described>((resolve) => {
			const onStop = () => end(STOPPED);
			const timer = setTimeout(
				() => end(messages().holdGeneric(tool)),
				this.#describeTimeoutMs,
			);
			let ended = false;
			const end = (described: Described) => {
				if (ended) return;
				ended = true;
				clearTimeout(timer);
				stop?.removeEventListener("abort", onStop);
				hold.abort();
				resolve(described);
			};
			// Handled first, so a rejection after the wait ended is never left unhandled.
			answer.then(end, () => end(messages().holdGeneric(tool)));
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

	/** The call for `action`, unless an approval releases it, which that approval then spends. */
	#unlessApproved(
		tool: string,
		input: Record<string, unknown>,
		action: string,
	): HeldCall | undefined {
		const minTier = this.#holds.approvalTier?.(tool, input, this.#context);
		const call: HeldCall = {
			tool,
			input: canonicalJson(input),
			action,
			...(minTier ? { minTier } : {}),
		};
		for (const released of [this.#approved, this.#lateApproved]) {
			const approved = released.findIndex(
				(c) => c.tool === call.tool && c.input === call.input,
			);
			if (approved !== -1) {
				released.splice(approved, 1);
				return undefined;
			}
		}
		return call;
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

/** The owner's approving message, preceded by the held calls it releases, so the model makes them again. */
export function confirmedTurnText(
	pending: PendingConfirmation,
	text: string,
	owner: OwnerIdentity,
): string {
	const calls = pending.calls
		.map((call) => `- ${call.action}: ${call.tool} ${call.input}`)
		.join("\n");
	return `(${owner.name} approved the held actions below with this message. Make each call now with exactly this input.)\n${calls}\n\n${text}`;
}

/**
 * Without a slot, or with an empty one, every call that needs confirmation is held. `turnOf` builds
 * the turn a hold that looks things up receives; without it, such a hold is not asked in a turn.
 */
export function confirmationGateExtension(
	gate: ConfirmationGate,
	slot?: PromptSlot,
	turnOf?: (signal: AbortSignal) => ToolTurn,
): ExtensionFactory {
	return (pi) => {
		/** Calls a card's approval released, until their results are back. */
		const approved = new Set<string>();
		pi.on("tool_result", (event) => {
			if (!approved.delete(event.toolCallId)) return undefined;
			const outcome = event.isError
				? "It was approved on its card and ran, but it failed:"
				: "It was approved on its card and ran; its result follows.";
			return {
				content: [{ type: "text", text: outcome }, ...event.content],
			};
		});
		pi.on("tool_call", async (event, ctx) => {
			const prompts = slot?.prompts;
			let ask: Parameters<ConfirmationGate["review"]>[2];
			if (prompts && slot) {
				ask = { prompts, asker: slot.asker };
				if (ctx.signal) ask.signal = ctx.signal;
			}
			const turn: HoldTurn | undefined = turnOf
				? { toolTurn: turnOf, ...(ctx.signal ? { signal: ctx.signal } : {}) }
				: undefined;
			const { reason, approvedOnCard, refused } = await gate.decide(
				event.toolName,
				event.input as Record<string, unknown>,
				ask,
				turn,
			);
			if (approvedOnCard) approved.add(event.toolCallId);
			if (refused) slot?.refuse(event.toolCallId, refused);
			return reason ? { block: true, reason } : undefined;
		});
	};
}
