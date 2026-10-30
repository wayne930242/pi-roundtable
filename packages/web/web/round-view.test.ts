import { expect, test } from "bun:test";
import type { RoundView } from "../src/api-types.ts";
import {
	facesOf,
	marksOf,
	replyNumber,
	speakerOfRound,
} from "./lib/round-view.ts";

const round = (over: Partial<RoundView> = {}): RoundView => ({
	id: 1,
	state: "running",
	next: [],
	spoken: [],
	replies: 0,
	limit: 8,
	...over,
});

test("the faces run in the order of the round: who spoke, who speaks, who is next", () => {
	expect(facesOf(undefined)).toEqual([]);
	expect(
		facesOf(
			round({ spoken: ["a"], current: "b", next: ["c", "a"], replies: 1 }),
		),
	).toEqual([
		{ name: "a", place: "spoken" },
		{ name: "b", place: "current" },
		{ name: "c", place: "next", order: 1 },
		{ name: "a", place: "next", order: 2 },
	]);
	expect(facesOf(round({ next: ["a", "b"] }))).toEqual([
		{ name: "a", place: "next", order: 1 },
		{ name: "b", place: "next", order: 2 },
	]);
});

test("a seat wears a number when it is next, a check once it spoke, and nothing while it speaks", () => {
	expect(marksOf(undefined)).toEqual({});
	expect(
		marksOf(round({ spoken: ["a", "b"], current: "c", next: ["d", "e"] })),
	).toEqual({ a: "✓", b: "✓", d: "①", e: "②" });
	// a member who spoke and is called again wears its place in the queue, the earliest one
	expect(
		marksOf(round({ spoken: ["a"], next: ["b", "a", "b"], replies: 1 })),
	).toEqual({ a: "②", b: "①" });
	// the one speaking wears none, even if it spoke before
	expect(marksOf(round({ spoken: ["a"], current: "a" }))).toEqual({});
	// a round that ended leaves the ring bare
	expect(
		marksOf(round({ state: "ended", ended: "done", spoken: ["a", "b"] })),
	).toEqual({});
});

test("only a running round has a speaker, and the reply it is on never passes the limit", () => {
	expect(speakerOfRound(undefined)).toBeUndefined();
	expect(speakerOfRound(round({ current: "a" }))).toBe("a");
	expect(
		speakerOfRound(round({ current: "a", state: "ended", ended: "done" })),
	).toBeUndefined();
	expect(replyNumber(round({ replies: 2 }))).toBe(2);
	expect(replyNumber(round({ replies: 2, current: "a" }))).toBe(3);
	expect(replyNumber(round({ replies: 8, current: "a" }))).toBe(8);
});
