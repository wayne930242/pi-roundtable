import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type {
	HeldCall,
	PendingConfirmation,
} from "../../domain/conversation.ts";
import type { OwnerPrompts } from "../../domain/owner-prompts.ts";
import { type HoldCheck, type HoldContext, higherTier } from "../../holds.ts";
import { messages } from "../../i18n/index.ts";
import { type OwnerIdentity, ownerWords } from "../../identity.ts";
import type { ToolTiers } from "../../tool-tiers.ts";
import type { PromptSlot } from "../prompt-slot.ts";

/** How much of a held call's input its approval card shows. */
const CARD_INPUT_CHARS = 1_500;

/** Held actions older than this cannot be approved any more. */
export const CONFIRMATION_TTL_MS = 24 * 3_600_000;

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
	#pending: PendingConfirmation | undefined;
	#approved: HeldCall[] = [];
	readonly #holds: HoldCheck;
	readonly #owner: OwnerIdentity;
	/** Whom the running turn's held actions and refusals speak of: the turn's speaker. */
	#addressee: OwnerIdentity;
	readonly #context: HoldContext;
	readonly #tiers: ToolTiers | undefined;

	/**
	 * `holds` decides which calls wait for the owner. With a workspace, the session has a shell,
	 * and its writes outside the workspace and the context's scratch dir are held too.
	 */
	constructor(
		holds: HoldCheck,
		owner: OwnerIdentity,
		pending?: PendingConfirmation,
		context: HoldContext = {},
		tiers?: ToolTiers,
	) {
		this.#tiers = tiers;
		this.#holds = holds;
		this.#owner = owner;
		this.#addressee = owner;
		this.#pending = pending;
		this.#context = context;
	}

	/** Held actions awaiting the owner's answer; expired ones count as none. */
	pending(now = new Date()): PendingConfirmation | undefined {
		const pending = this.#pending;
		if (!pending) return undefined;
		return now.getTime() - pending.heldAt.getTime() > CONFIRMATION_TTL_MS
			? undefined
			: pending;
	}

	/** `addressee` is who the turn is for; without one, the owner. */
	beginTurn(
		selectionId: string,
		confirmed: boolean,
		addressee?: OwnerIdentity,
	): void {
		this.#selectionId = selectionId;
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
		ask?: { prompts: OwnerPrompts; asker: string; signal?: AbortSignal },
	): Promise<string | undefined> {
		return (await this.decide(tool, input, ask)).reason;
	}

	/**
	 * `review`, plus whether a card's approval released the call, so its result can say so:
	 * the card's own message is shown to the person, never to the model.
	 */
	async decide(
		tool: string,
		input: Record<string, unknown>,
		ask?: { prompts: OwnerPrompts; asker: string; signal?: AbortSignal },
	): Promise<{ reason?: string; approvedOnCard?: true }> {
		const call = this.#needing(tool, input);
		if (!call) return {};
		if (!ask) return { reason: this.#record(call) };
		const answer = await ask.prompts.confirm(
			messages().confirmTitle(ask.asker),
			approvalCard(call),
			ask.signal,
			higherTier(this.#tiers?.minTier(call.tool), call.minTier),
		);
		if (answer === "approved") return { approvedOnCard: true };
		if (answer === "declined") {
			const o = ownerWords(this.#addressee);
			return {
				reason: `${o.name} declined this on its approval card: it would ${call.action}. Do not retry it; go on without it, or ask ${o.him} what ${o.he} wants instead.`,
			};
		}
		if (answer === "cancelled") return { reason: "The turn was stopped." };
		return { reason: this.#record(call) };
	}

	/** The call when it needs the owner's confirmation and no approval releases it. */
	#needing(tool: string, input: Record<string, unknown>): HeldCall | undefined {
		const context = this.#context;
		const action = this.#holds(tool, input, context);
		if (!action) return undefined;
		const minTier = this.#holds.approvalTier?.(tool, input, context);
		const call: HeldCall = {
			tool,
			input: canonicalJson(input),
			action,
			...(minTier ? { minTier } : {}),
		};
		const approved = this.#approved.findIndex(
			(c) => c.tool === call.tool && c.input === call.input,
		);
		if (approved !== -1) {
			this.#approved.splice(approved, 1);
			return undefined;
		}
		return call;
	}

	#record(call: HeldCall): string {
		const selectionId = this.#selectionId;
		if (selectionId === undefined)
			throw new Error("a call was held outside a turn");
		const pending = this.#pending ?? {
			selectionId,
			heldAt: new Date(),
			calls: [],
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

/** What an approval card says: the held action's words, then the exact call. */
export function approvalCard(call: HeldCall): string {
	const input =
		call.input.length > CARD_INPUT_CHARS
			? `${call.input.slice(0, CARD_INPUT_CHARS)}…`
			: call.input;
	return `**${call.action}**\n-# \`${call.tool}\`\n\`\`\`json\n${input.replaceAll("```", "`\u200b``")}\n\`\`\``;
}

/** Without a slot, or with an empty one, every call that needs confirmation is held. */
export function confirmationGateExtension(
	gate: ConfirmationGate,
	slot?: PromptSlot,
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
			const { reason, approvedOnCard } = await gate.decide(
				event.toolName,
				event.input as Record<string, unknown>,
				ask,
			);
			if (approvedOnCard) approved.add(event.toolCallId);
			return reason ? { block: true, reason } : undefined;
		});
	};
}
