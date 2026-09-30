import { describe, expect, test } from "bun:test";
import { CardCadence, CONVERSATION_GAP_MS } from "./card-cadence.ts";
import { headline } from "./headline.ts";
import { quietLinks } from "./quiet-links.ts";
import { DISCORD_MESSAGE_LIMIT, splitReply } from "./reply-splitter.ts";
import { THINKING_LIMIT, thinkingLine } from "./thinking-line.ts";

describe("headline", () => {
	test("takes the first sentence", () => {
		expect(headline("Today is a nice day。Let us go for a walk！")).toBe(
			"Today is a nice day。",
		);
		expect(headline("Bun 1.4.2 is out. It fixes a lot.")).toBe(
			"Bun 1.4.2 is out.",
		);
	});

	test("does not stop at a decimal point", () => {
		expect(headline("Version 1.4.2 ships today")).toBe(
			"Version 1.4.2 ships today",
		);
	});

	test("strips markdown and skips code", () => {
		expect(
			headline(
				"```ts\nconst x = 1;\n```\n## **Key point**：see [this post](https://x.y)",
			),
		).toBe("Key point：see this post");
		expect(headline("- `bun` is fast")).toBe("bun is fast");
	});

	test("truncates to 80 characters", () => {
		const result = headline("é".repeat(120));
		expect(Array.from(result)).toHaveLength(80);
		expect(result.endsWith("…")).toBe(true);
	});

	test("emoji are left out, since the card font cannot draw them", () => {
		expect(headline("Schedule test OK，get some water 💧")).toBe(
			"Schedule test OK，get some water",
		);
		expect(headline("🎉 Congrats 👍🏽 done 🇹🇼！")).toBe("Congrats done ！");
		expect(headline("👨‍👩‍👧 family❤️ all good")).toBe("family all good");
		expect(headline("💧")).toBe("");
	});

	test("empty text gives an empty headline", () => {
		expect(headline("\n\n")).toBe("");
	});
});

describe("splitReply", () => {
	test("short text stays one message", () => {
		expect(splitReply("hello\n\nworld")).toEqual(["hello\n\nworld"]);
	});

	test("splits on paragraph boundaries within the limit", () => {
		const [a, b, c] = ["a".repeat(900), "b".repeat(900), "c".repeat(900)];
		expect(splitReply(`${a}\n\n${b}\n\n${c}`)).toEqual([`${a}\n\n${b}`, c]);
	});

	test("keeps a code block with blank lines intact", () => {
		const code = "```ts\nconst a = 1;\n\nconst b = 2;\n```";
		const text = `${"x".repeat(1980)}\n\n${code}`;
		expect(splitReply(text)).toEqual(["x".repeat(1980), code]);
	});

	test("a long code block becomes several complete code blocks", () => {
		const body = Array.from(
			{ length: 200 },
			(_, i) => `line ${i} ${"-".repeat(20)}`,
		).join("\n");
		const chunks = splitReply(`\`\`\`ts\n${body}\n\`\`\``);
		expect(chunks.length).toBeGreaterThan(1);
		for (const chunk of chunks) {
			expect(chunk.length).toBeLessThanOrEqual(2000);
			expect(chunk.startsWith("```ts\n")).toBe(true);
			expect(chunk.endsWith("\n```")).toBe(true);
		}
		const rejoined = chunks.map((c) => c.slice(6, -4)).join("\n");
		expect(rejoined).toBe(body);
	});

	test("one overlong line is split by characters", () => {
		const chunks = splitReply("é".repeat(4500));
		expect(chunks.map((c) => c.length)).toEqual([2000, 2000, 500]);
	});

	test("every chunk respects the limit", () => {
		const text = Array.from(
			{ length: 50 },
			(_, i) => `Paragraph ${i} ${"é".repeat(i * 10)}`,
		).join("\n\n");
		const chunks = splitReply(text);
		expect(chunks.every((c) => c.length <= 2000)).toBe(true);
		expect(chunks.join("\n\n")).toBe(text);
	});
});

describe("quietLinks", () => {
	test("wraps cited links and keeps sentence punctuation outside", () => {
		expect(
			quietLinks("Source：https://example.com/a?b=1。Also https://x.org/p."),
		).toBe("Source：<https://example.com/a?b=1>。Also <https://x.org/p>.");
	});

	test("GIF and video links keep their preview", () => {
		const text =
			"https://giphy.com/gifs/clap\nhttps://www.youtube.com/watch?v=abc";
		expect(quietLinks(text)).toBe(text);
	});

	test("markdown links and already wrapped links", () => {
		expect(
			quietLinks("[review](https://example.com/r) and <https://a.io>"),
		).toBe("[review](<https://example.com/r>) and <https://a.io>");
	});
});

describe("thinkingLine", () => {
	test("each line becomes small grey text and blank lines are dropped", () => {
		expect(thinkingLine("  check the date\n\nthen answer  ")).toBe(
			"-# check the date\n-# then answer",
		);
		expect(thinkingLine("   ")).toBeUndefined();
	});

	test("long thinking is cut and stays within one message", () => {
		const line = thinkingLine("é".repeat(THINKING_LIMIT + 50));
		expect(line?.endsWith("…")).toBe(true);
		expect(line?.length).toBeLessThanOrEqual(DISCORD_MESSAGE_LIMIT);
	});
});

describe("card cadence", () => {
	const at = (minutes: number) => minutes * 60_000;

	test("a conversation's first reply shows a card; the same tone does not repeat it", () => {
		const cadence = new CardCadence();
		expect(cadence.shows("discord:1", "neutral", false, at(0))).toBe(true);
		expect(cadence.shows("discord:1", "neutral", false, at(1))).toBe(false);
		expect(cadence.shows("discord:1", "happy", false, at(2))).toBe(true);
		expect(cadence.shows("discord:1", "happy", false, at(3))).toBe(false);
		expect(cadence.shows("discord:1", "neutral", false, at(4))).toBe(false);
		expect(cadence.shows("discord:1", "thinking", false, at(5))).toBe(true);
	});

	test("a quiet channel opens a new conversation", () => {
		const cadence = new CardCadence();
		cadence.shows("discord:1", "neutral", false, 0);
		expect(
			cadence.shows("discord:1", "neutral", false, CONVERSATION_GAP_MS - 1),
		).toBe(false);
		expect(
			cadence.shows("discord:1", "neutral", false, 2 * CONVERSATION_GAP_MS - 1),
		).toBe(true);
	});

	test("a failure always shows its card; channels are independent", () => {
		const cadence = new CardCadence();
		cadence.shows("discord:1", "apologetic", true, at(0));
		expect(cadence.shows("discord:1", "apologetic", true, at(1))).toBe(true);
		expect(cadence.shows("discord:2", "neutral", false, at(1))).toBe(true);
	});
});
