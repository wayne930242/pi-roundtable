import { describe, expect, test } from "bun:test";
import { hasLeadingAiMention, withoutLeadingAiMention } from "./lib/mention.ts";

describe("hasLeadingAiMention", () => {
	test("finds the token as the first word, in any case, before a space, colon, comma or the end", () => {
		for (const text of [
			"@AI",
			"@ai summarize this",
			"  @Ai: go",
			"@AI, please",
			"@AI，請看",
			"@AI\nnext line",
		])
			expect(hasLeadingAiMention(text)).toBe(true);
	});

	test("ignores a mention elsewhere, an address, a longer word and other text", () => {
		for (const text of [
			"hey @AI, what now",
			"mail a@ai.com",
			"@ai.com is a domain",
			"@AIX does it",
			"@ai-bot",
			"@ai_bot",
			"@AI.",
			"@AI?",
			"@@AI",
			"AI is here",
			"",
		])
			expect(hasLeadingAiMention(text)).toBe(false);
	});
});

describe("withoutLeadingAiMention", () => {
	test("takes a leading token with the space, colon or comma after it", () => {
		expect(withoutLeadingAiMention("@AI summarize")).toBe("summarize");
		expect(withoutLeadingAiMention("@ai: summarize")).toBe("summarize");
		expect(withoutLeadingAiMention("  @AI , summarize")).toBe("summarize");
		expect(withoutLeadingAiMention("@AI，請看")).toBe("請看");
		expect(withoutLeadingAiMention("@AI")).toBe("");
	});

	test("leaves a mention elsewhere and text that is not a leading mention", () => {
		expect(withoutLeadingAiMention("tell @AI to wait")).toBe(
			"tell @AI to wait",
		);
		expect(withoutLeadingAiMention("@ai.com is a domain")).toBe(
			"@ai.com is a domain",
		);
		expect(withoutLeadingAiMention("@AIX go")).toBe("@AIX go");
		expect(withoutLeadingAiMention("plain")).toBe("plain");
	});
});
