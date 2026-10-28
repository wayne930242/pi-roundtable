import type { AvatarState } from "pi-roundtable/characters";
import type { ActivityPhase } from "../../src/api-types.ts";

// What an agent's character shows: one pure function from what the page knows of its room, so the
// rules can be tested without a browser. Times are epoch milliseconds on the page's clock.

/** How long `done` shows after a turn ends. */
export const DONE_MS = 2500;
/** The longest a failed turn keeps showing as `error`, if the room is not opened or a turn started first. */
export const ERROR_MS = 10 * 60_000;
/** An agent quiet for this long is sleepy. */
export const SLEEPY_AFTER_MS = 8 * 3_600_000;
/** The local hours (from, up to but not including) in which a quiet hour makes an agent sleepy. */
const NIGHT = { from: 1, to: 6 } as const;
const QUIET_NIGHT_MS = 3_600_000;

export interface PresenceInput {
	/** The room's agent is working now. */
	typing: boolean;
	/** While typing: `working` during a tool call, `thinking` otherwise. */
	phase?: ActivityPhase | undefined;
	/** Cards open in the room. */
	prompts: number;
	/** How the last turn ended, until the next turn starts or the room is opened. */
	outcome?: "done" | "failed" | undefined;
	outcomeAt?: number | undefined;
	/** The newest sign of life in the room: a message or an activity frame. */
	lastActivityAt?: number | undefined;
	/** The agent works somewhere (Discord, another room) according to the presence frame. */
	busyElsewhere: boolean;
}

/** The state the character shows, by the rules in the order they apply. */
export function presenceOf(input: PresenceInput, now: number): AvatarState {
	if (input.prompts > 0) return "waiting";
	if (input.typing && input.phase === "working") return "working";
	if (input.typing || input.busyElsewhere)
		return input.phase === "thinking" ? "thinking" : "working";
	const age = input.outcomeAt === undefined ? undefined : now - input.outcomeAt;
	if (input.outcome === "failed" && (age === undefined || age < ERROR_MS))
		return "error";
	if (input.outcome === "done" && age !== undefined && age < DONE_MS)
		return "done";
	if (sleepy(input, now)) return "sleepy";
	return "idle";
}

function sleepy(input: PresenceInput, now: number): boolean {
	const quiet =
		input.lastActivityAt === undefined
			? Number.POSITIVE_INFINITY
			: now - input.lastActivityAt;
	if (input.lastActivityAt !== undefined && quiet > SLEEPY_AFTER_MS)
		return true;
	const hour = new Date(now).getHours();
	return hour >= NIGHT.from && hour < NIGHT.to && quiet >= QUIET_NIGHT_MS;
}

/** Milliseconds until `done` or `error` lapses on its own, so the page draws again then; none when nothing lapses. */
export function stateChangesIn(
	input: PresenceInput,
	now: number,
): number | undefined {
	if (input.prompts > 0 || input.typing || input.busyElsewhere)
		return undefined;
	if (input.outcome === undefined || input.outcomeAt === undefined)
		return undefined;
	const lasts = input.outcome === "done" ? DONE_MS : ERROR_MS;
	const left = input.outcomeAt + lasts - now;
	return left > 0 ? left : undefined;
}
