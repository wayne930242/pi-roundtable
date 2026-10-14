import type {
	HeldCall,
	PendingConfirmation,
} from "../../domain/conversation.ts";
import type { OwnerIdentity } from "../../identity.ts";
import type { ApprovedBy } from "../../interactions/prompts.ts";
import type { Speaker } from "../../speakers.ts";

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

/** Whether two held calls are the same call: the same tool with the same canonical input. */
export function sameCall(
	a: Pick<HeldCall, "tool" | "input">,
	b: Pick<HeldCall, "tool" | "input">,
): boolean {
	return a.tool === b.tool && a.input === b.input;
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
 * Whether a call's `approverIds` leave the person free to approve it: always, for a call that names
 * none, since whoever asked decides who the person is; for one that does, only an owner or a named
 * principal. Nobody known, such as a turn without a speaker, may approve a call that names approvers.
 */
export function mayApproveNamed(
	person:
		| (Pick<Speaker, "principalId"> & { tier?: Speaker["tier"] })
		| undefined,
	call: Pick<HeldCall, "approverIds">,
): boolean {
	if (!call.approverIds) return true;
	return (
		person !== undefined &&
		(person.tier === "owner" || call.approverIds.includes(person.principalId))
	);
}

/** Whether an approval reported for a call is one its `approverIds` accept: from a named principal or an owner. */
export function namedApprover(
	call: Pick<HeldCall, "approverIds">,
	by: ApprovedBy | undefined,
): boolean {
	if (!call.approverIds) return true;
	return (
		by !== undefined &&
		(by.owner === true || call.approverIds.includes(by.principalId))
	);
}
