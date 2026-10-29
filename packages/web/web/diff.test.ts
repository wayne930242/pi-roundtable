import { expect, test } from "bun:test";
import { diffCounts, lineDiff } from "./lib/diff.ts";

const shown = (before: string, after: string) =>
	lineDiff(before, after).map(
		(line) => `${{ same: " ", add: "+", del: "-" }[line.kind]}${line.text}`,
	);

test("equal texts are all kept", () => {
	expect(shown("a\nb", "a\nb")).toEqual([" a", " b"]);
});

test("a changed line is a removal and an addition between the kept lines", () => {
	expect(shown("one\ntwo\nthree", "one\n2\nthree")).toEqual([
		" one",
		"-two",
		"+2",
		" three",
	]);
});

test("lines inserted and deleted away from each other are matched by what is kept", () => {
	expect(shown("a\nb\nc\nd\ne", "a\nc\nd\nx\ne")).toEqual([
		" a",
		"-b",
		" c",
		" d",
		"+x",
		" e",
	]);
});

test("an empty before is all additions; an emptied text is all removals", () => {
	expect(diffCounts(lineDiff("", "x\ny"))).toEqual({ added: 2, removed: 1 });
	expect(diffCounts(lineDiff("x\ny", ""))).toEqual({ added: 1, removed: 2 });
});

test("a text too long to compare is shown as replaced rather than hanging", () => {
	const before = Array.from({ length: 2500 }, (_, i) => `a${i}`).join("\n");
	const after = Array.from({ length: 2500 }, (_, i) => `b${i}`).join("\n");
	expect(diffCounts(lineDiff(before, after))).toEqual({
		added: 2500,
		removed: 2500,
	});
});
