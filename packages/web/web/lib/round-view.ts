import type { RoundView } from "../../src/api-types.ts";

// What a group's round shows: the strip over the dialogue box lists who has spoken, who speaks and
// who is next, and each seat of the ring carries the same sign, so the two agree. All of it is a pure
// reading of the `round` the server tells, tested without a browser.

/** Where a face of the strip stands in the round. */
export type Place = "spoken" | "current" | "next";

export interface RoundFace {
	/** The member, by name. */
	name: string;
	place: Place;
	/** The place in the queue of a face that is next, from 1. */
	order?: number;
}

/** The numbers a seat shows for the members who are next: circled digits, one to eight. */
const CIRCLED = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧"] as const;
const CHECK = "✓";

/** The faces of a round in the order it runs: who spoke, who speaks now, who is next. */
export function facesOf(round: RoundView | undefined): RoundFace[] {
	if (!round) return [];
	return [
		...round.spoken.map((name): RoundFace => ({ name, place: "spoken" })),
		...(round.current === undefined
			? []
			: [{ name: round.current, place: "current" } satisfies RoundFace]),
		...round.next.map(
			(name, index): RoundFace => ({ name, place: "next", order: index + 1 }),
		),
	];
}

/**
 * The sign a seat wears while the round runs: a number for a member who is next (the earliest of its
 * places in the queue), a check for one who has spoken and is not next again, nothing for the one
 * who speaks now. A round that ended leaves the ring bare; its strip keeps the story.
 */
export function marksOf(
	round: RoundView | undefined,
): Readonly<Record<string, string>> {
	const marks: Record<string, string> = {};
	if (round?.state !== "running") return marks;
	for (const name of round.spoken) marks[name] = CHECK;
	const numbered = new Set<string>();
	round.next.forEach((name, index) => {
		const number = CIRCLED[index];
		if (number === undefined || numbered.has(name)) return;
		numbered.add(name);
		marks[name] = number;
	});
	if (round.current !== undefined) delete marks[round.current];
	return marks;
}

/** The member speaking now while the round runs; none between two turns or once it ended. */
export const speakerOfRound = (
	round: RoundView | undefined,
): string | undefined =>
	round?.state === "running" ? round.current : undefined;

/**
 * Which reply the round is on, from 1: the one being spoken, or the last made while nobody speaks.
 * Never more than the limit.
 */
export function replyNumber(round: RoundView): number {
	const now = round.current === undefined ? round.replies : round.replies + 1;
	return Math.min(Math.max(now, 0), round.limit);
}
