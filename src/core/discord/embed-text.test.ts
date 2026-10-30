import { expect, test } from "bun:test";
import { EMBED_TEXT_CHARS, embedText, withEmbeds } from "./embed-text.ts";

const embed = (extra: Record<string, unknown> = {}) =>
	({
		title: null,
		description: null,
		url: null,
		fields: [],
		footer: null,
		author: null,
		...extra,
	}) as never;

test("an embed reads as its title, description, fields, footer and link, one per line", () => {
	expect(
		embedText([
			embed({
				author: { name: "CI" },
				title: "Build 42 failed",
				description: "main is red",
				fields: [
					{ name: "Branch", value: "main", inline: true },
					{ name: "Duration", value: "3m", inline: true },
				],
				footer: { text: "ci.example.com" },
				url: "https://ci.example.com/42",
			}),
		]),
	).toBe(
		[
			"CI — Build 42 failed",
			"main is red",
			"Branch: main",
			"Duration: 3m",
			"ci.example.com",
			"https://ci.example.com/42",
		].join("\n"),
	);
});

test("several embeds are apart by a blank line, and an empty one adds nothing", () => {
	expect(
		embedText([embed({ title: "one" }), embed(), embed({ title: "two" })]),
	).toBe("one\n\ntwo");
	expect(embedText([])).toBe("");
});

test("the embeds' text is cut at the limit and marked", () => {
	const text = embedText([embed({ description: "x".repeat(10_000) })]);
	expect(text).toHaveLength(EMBED_TEXT_CHARS);
	expect(text.endsWith("…")).toBe(true);
});

test("text and embeds are joined, either one alone stands, and markup stays as written", () => {
	const alert = embed({ title: "**HighLoad** `db`" });
	expect(withEmbeds("see below", [alert])).toBe(
		"see below\n\n**HighLoad** `db`",
	);
	expect(withEmbeds("", [alert])).toBe("**HighLoad** `db`");
	expect(withEmbeds(" plain ", [])).toBe("plain");
});
