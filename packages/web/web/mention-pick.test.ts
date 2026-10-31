import { expect, test } from "bun:test";
import { matchMembers, mentionTrigger } from "./lib/mention-pick.ts";

test("an @ at a word start, up to the caret, is the trigger; one inside a word is not", () => {
	expect(mentionTrigger("@", 1)).toEqual({ from: 0, query: "" });
	expect(mentionTrigger("hi @sc", 6)).toEqual({ from: 3, query: "sc" });
	expect(mentionTrigger("line\n@gu", 8)).toEqual({ from: 5, query: "gu" });
	// The caret decides: text after it is not the query.
	expect(mentionTrigger("hi @scout there", 5)).toEqual({ from: 3, query: "s" });
	expect(mentionTrigger("mail me@home", 12)).toBeUndefined();
	expect(mentionTrigger("hi @scout there", 15)).toBeUndefined();
	expect(mentionTrigger("no sign", 7)).toBeUndefined();
	expect(mentionTrigger("a@@b", 4)).toBeUndefined();
});

test("a leading @AI is the room's own shorthand and never opens the list; elsewhere it may", () => {
	expect(mentionTrigger("@ai", 3)).toBeUndefined();
	expect(mentionTrigger("  @AI", 5)).toBeUndefined();
	expect(mentionTrigger("@aid", 4)).toEqual({ from: 0, query: "aid" });
	expect(mentionTrigger("ask @ai", 7)).toEqual({ from: 4, query: "ai" });
});

test("members filter by what their display name or name starts with, then what holds it, in group order", () => {
	const members = [
		{ name: "guide", displayName: "Guide" },
		{ name: "ops-lead", displayName: "Captain" },
		{ name: "scout", displayName: "Blog Editor" },
		{ name: "aide", displayName: "Aide Two" },
	];
	expect(matchMembers(members, "").map((m) => m.name)).toEqual([
		"guide",
		"ops-lead",
		"scout",
		"aide",
	]);
	expect(matchMembers(members, "ops").map((m) => m.name)).toEqual(["ops-lead"]);
	expect(matchMembers(members, "ED").map((m) => m.name)).toEqual(["scout"]);
	// Starts first, then holds: "ai" starts "Aide Two" and is inside "Captain".
	expect(matchMembers(members, "ai").map((m) => m.name)).toEqual([
		"aide",
		"ops-lead",
	]);
	expect(matchMembers(members, "zzz")).toEqual([]);
});
