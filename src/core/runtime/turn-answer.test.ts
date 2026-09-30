import { describe, expect, test } from "bun:test";
import { lastReply, thinkingOf, turnAnswer } from "./turn-answer.ts";

const assistant = (
	text: string,
	stopReason = "stop",
	thinking?: { thinking: string; redacted?: boolean },
) => ({
	role: "assistant",
	stopReason,
	content: [
		...(thinking ? [{ type: "thinking", ...thinking }] : []),
		{ type: "text", text },
	],
});
const user = { role: "user", content: "hi" };

describe("turnAnswer", () => {
	test("answers with the last message's text and its visible thinking", () => {
		expect(
			turnAnswer(
				[
					user,
					assistant("tool call", "toolUse", { thinking: " plan " }),
					assistant(" done ", "stop", { thinking: "secret", redacted: true }),
				],
				false,
			),
		).toEqual({ ok: true, text: "done", thinking: "plan" });
	});

	test("keeps every final answer of a steered run", () => {
		expect(
			turnAnswer(
				[
					assistant("first"),
					user,
					assistant("tool", "toolUse"),
					assistant("second"),
				],
				true,
			),
		).toEqual({ ok: true, text: "first\n\nsecond" });
	});

	test("fails without a usable answer", () => {
		const none = turnAnswer([user], false);
		expect(none.ok || none.error.message).toBe(
			"the run produced no assistant message",
		);
		const blank = turnAnswer([assistant("  ")], false);
		expect(blank.ok || blank.error.message).toBe(
			"the final assistant message has no text",
		);
	});
});

describe("session helpers", () => {
	test("lastReply is the last answer's text, or undefined", () => {
		expect(lastReply([assistant("a"), user, assistant(" b ")])).toBe("b");
		expect(lastReply([user])).toBeUndefined();
	});

	test("thinkingOf skips redacted thinking", () => {
		expect(
			thinkingOf([
				assistant("x", "stop", { thinking: "one" }),
				assistant("y", "stop", { thinking: "two", redacted: true }),
			]),
		).toBe("one");
	});
});
