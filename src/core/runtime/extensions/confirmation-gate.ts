import { statSync } from "node:fs";
import { resolve } from "node:path";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type {
	HeldCall,
	PendingConfirmation,
} from "../../domain/conversation.ts";
import type { HoldRefusal } from "../../domain/progress.ts";
import { type HoldCheck, type HoldContext, higherTier } from "../../holds.ts";
import { messages } from "../../i18n/index.ts";
import { type OwnerIdentity, ownerWords } from "../../identity.ts";
import type {
	ApprovalDetails,
	LateAnswer,
	Prompts,
} from "../../interactions/prompts.ts";
import type { Speaker } from "../../speakers.ts";
import type { ToolTiers } from "../../tool-tiers.ts";
import type { PromptSlot } from "../prompt-slot.ts";

/** How many characters of one string value in a held call's input its approval card shows. */
const CARD_VALUE_CHARS = 200;

/** How many characters of the whole input its approval card shows, at most. */
const CARD_INPUT_CHARS = 1_500;

/** What an approval card shows of a call's input; see `approvalCard`. */
export interface CardLimits {
	/** Longest string value kept whole, at any depth; a longer one is cut and marked with its length. */
	valueChars?: number;
	/** Longest input shown, after the values are cut; the rest is dropped. */
	totalChars?: number;
}

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

	/**
	 * `holds` decides which calls wait for the owner. With a workspace, the session has a shell,
	 * and its writes outside the workspace and the context's scratch dir are held too.
	 * `fileRoot` is the session's working directory, where a card resolves relative file paths;
	 * it defaults to the workspace.
	 */
	constructor(
		holds: HoldCheck,
		owner: OwnerIdentity,
		pending?: PendingConfirmation,
		context: HoldContext = {},
		tiers?: ToolTiers,
		fileRoot?: string,
	) {
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
	): Promise<string | undefined> {
		return (await this.decide(tool, input, ask)).reason;
	}

	/**
	 * `review`, plus whether a card's approval released the call, so its result can say so:
	 * the card's own message is shown to the person, never to the model. When a hold refuses the
	 * call, `refused` says how, for the turn's progress to report beside the failed result.
	 */
	async decide(
		tool: string,
		input: Record<string, unknown>,
		ask?: { prompts: Prompts; asker: string; signal?: AbortSignal },
	): Promise<{
		reason?: string;
		approvedOnCard?: true;
		/** Why a hold refused the call, for a surface that tells that from a failure; absent when it ran or the turn stopped. */
		refused?: HoldRefusal;
	}> {
		const call = this.#needing(tool, input);
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
 * What an approval card says: the held action's words, the exact call, and each file it sends by
 * path with the file's size now; relative paths resolve against `workspace`. A string value in
 * the input longer than `limits.valueChars` is cut and marked with its length, so one long value
 * does not push the keys after it out of the card; `limits.totalChars` caps what is left.
 */
export function approvalCard(
	call: HeldCall,
	workspace?: string,
	limits: CardLimits = {},
): string {
	const total = limits.totalChars ?? CARD_INPUT_CHARS;
	const shown = cutValues(call.input, limits.valueChars ?? CARD_VALUE_CHARS);
	const input = shown.length > total ? `${shown.slice(0, total)}…` : shown;
	const files = pathFiles(call.input).map(
		(path) => `\n-# ${messages().cardFile(path, fileSize(path, workspace))}`,
	);
	return `**${call.action}**\n-# \`${call.tool}\`\n\`\`\`json\n${input.replaceAll("```", "`\u200b``")}\n\`\`\`${files.join("")}`;
}

/** The call's input as JSON with each string longer than `limit` cut and marked `… [N chars]`; the input itself when none is. */
function cutValues(input: string, limit: number): string {
	let parsed: unknown;
	try {
		parsed = JSON.parse(input);
	} catch {
		return input;
	}
	let cut = false;
	const shown = JSON.stringify(parsed, (_key, v: unknown) => {
		if (typeof v !== "string" || v.length <= limit) return v;
		cut = true;
		return `${v.slice(0, limit)}… [${v.length} chars]`;
	});
	return cut ? shown : input;
}

/**
 * A held call as data for a card that is not text: the action, the tool, the whole input, and
 * each file it sends by path with its size now (absent when unreadable). Unlike the text card,
 * nothing is cut and nothing is worded for a locale.
 */
export function approvalDetails(
	call: HeldCall,
	workspace?: string,
): ApprovalDetails {
	const files = pathFiles(call.input).map((path) => {
		const bytes = fileSize(path, workspace);
		return bytes === undefined ? { path } : { path, bytes };
	});
	return {
		action: call.action,
		tool: call.tool,
		input: parsedInput(call.input),
		...(files.length > 0 ? { files } : {}),
	};
}

/** A call's input object; `{}` for input that is not one (a held call's always is). */
function parsedInput(input: string): Record<string, unknown> {
	try {
		const parsed: unknown = JSON.parse(input);
		return isPlainObject(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

/** The paths of a call's `files` entries that name one. */
function pathFiles(input: string): string[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(input);
	} catch {
		return [];
	}
	const files = isPlainObject(parsed) ? parsed.files : undefined;
	if (!Array.isArray(files)) return [];
	return files.flatMap((file: unknown) =>
		isPlainObject(file) && typeof file.path === "string" ? [file.path] : [],
	);
}

/** A file's size in bytes, or undefined when it cannot be read. */
function fileSize(path: string, workspace: string | undefined) {
	try {
		const info = statSync(resolve(workspace ?? "/", path));
		return info.isFile() ? info.size : undefined;
	} catch {
		return undefined;
	}
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
			const { reason, approvedOnCard, refused } = await gate.decide(
				event.toolName,
				event.input as Record<string, unknown>,
				ask,
			);
			if (approvedOnCard) approved.add(event.toolCallId);
			if (refused) slot?.refuse(event.toolCallId, refused);
			return reason ? { block: true, reason } : undefined;
		});
	};
}
