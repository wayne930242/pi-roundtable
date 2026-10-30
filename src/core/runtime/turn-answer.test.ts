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
				true,
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
				true,
			),
		).toEqual({ ok: true, text: "first\n\nsecond" });
	});

	test("fails without a usable answer", () => {
		const none = turnAnswer([user], false, true);
		expect(none.ok || none.error.message).toBe(
			"the run produced no assistant message",
		);
		const blank = turnAnswer([assistant("  ")], false, true);
		expect(blank.ok || blank.error.message).toBe(
			"the final assistant message has no text",
		);
	});

	test("an unattended turn with nothing to say answers with empty text", () => {
		expect(turnAnswer([user, assistant("  ")], false, false)).toEqual({
			ok: true,
			text: "",
		});
		expect(
			turnAnswer([assistant("tool", "toolUse"), assistant("")], true, false),
		).toEqual({ ok: true, text: "" });
	});

	test("an unattended turn still fails without an assistant message", () => {
		const none = turnAnswer([user], false, false);
		expect(none.ok || none.error.message).toBe(
			"the run produced no assistant message",
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
