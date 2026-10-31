import { expect, test } from "bun:test";
import { intercomFolds, intercomPlain, intercomSummary } from "./intercom.ts";

const peer = { name: "infra", displayName: "Infrastructure" };

test("a card's summary is its first line with words, without a heading's marks", () => {
	expect(intercomSummary("\n\n## Disk report\n\n80% used")).toBe("Disk report");
	expect(intercomSummary("")).toBe("");
});

test("a long first line is cut with an ellipsis, never through a surrogate pair", () => {
	expect(intercomSummary("abcdefghij", 5)).toBe("abcd…");
	const emoji = `abc${"😀".repeat(5)}`;
	expect(intercomSummary(emoji, 6)).toBe("abc😀…");
	// A cut that would split the second emoji keeps only the whole one before it.
	expect(intercomSummary(emoji, 5)).toBe("abc…");
});

test("a card folds only when its summary leaves part of the text out", () => {
	expect(intercomFolds({ kind: "sent", peer, text: "check the disk" })).toBe(
		false,
	);
	expect(intercomFolds({ kind: "sent", peer, text: "check\nthe disk" })).toBe(
		true,
	);
});

test("a surface without cards reads the heading, then the whole text", () => {
	expect(intercomPlain({ kind: "answered", peer, text: "a\nb" })).toBe(
		"← From **Infrastructure**\na\nb",
	);
});
