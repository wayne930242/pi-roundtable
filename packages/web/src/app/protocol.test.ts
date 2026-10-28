import { describe, expect, test } from "bun:test";
import { parseClientFrame } from "./protocol.ts";

const parse = (value: unknown) => parseClientFrame(JSON.stringify(value));

describe("client frames", () => {
	test("each frame of the protocol parses to exactly its fields", () => {
		expect(
			parse({
				type: "hello",
				visible: true,
				focus: "app:agent.guide",
				extra: 1,
			}),
		).toEqual({
			type: "hello",
			visible: true,
			focus: "app:agent.guide",
		});
		expect(parse({ type: "visibility", visible: false })).toEqual({
			type: "visibility",
			visible: false,
		});
		expect(parse({ type: "focus" })).toEqual({ type: "focus" });
		expect(
			parse({
				type: "send",
				id: "1",
				room: "app:agent.guide",
				text: "hi",
				uploads: ["a"],
			}),
		).toEqual({
			type: "send",
			id: "1",
			room: "app:agent.guide",
			text: "hi",
			uploads: ["a"],
		});
		expect(
			parse({ type: "send", id: "1", room: "r", text: "", uploads: [] }),
		).toEqual({
			type: "send",
			id: "1",
			room: "r",
			text: "",
		});
		expect(parse({ type: "stop", room: "r" })).toEqual({
			type: "stop",
			room: "r",
		});
		expect(parse({ type: "approval", prompt: "p", approved: false })).toEqual({
			type: "approval",
			prompt: "p",
			approved: false,
		});
		expect(
			parse({
				type: "answer",
				prompt: "p",
				answer: { choices: ["a"], text: "t" },
			}),
		).toEqual({
			type: "answer",
			prompt: "p",
			answer: { choices: ["a"], text: "t" },
		});
		expect(
			parse({
				type: "answers",
				prompt: "p",
				answers: [null, { choices: [] }],
				note: "n",
			}),
		).toEqual({
			type: "answers",
			prompt: "p",
			answers: [null, { choices: [] }],
			note: "n",
		});
		expect(parse({ type: "cancel", prompt: "p" })).toEqual({
			type: "cancel",
			prompt: "p",
		});
	});

	test("anything else is refused", () => {
		for (const bad of [
			"not json",
			"[]",
			"null",
			{ type: "unknown" },
			{ type: "hello" },
			{ type: "send", id: "1", room: "r" },
			{ type: "send", id: "", room: "r", text: "" },
			{
				type: "send",
				id: "1",
				room: "r",
				text: "",
				uploads: ["1", "2", "3", "4", "5"],
			},
			{ type: "send", id: "1", room: "r", text: "", uploads: [3] },
			{ type: "approval", prompt: "p", approved: "yes" },
			{ type: "answer", prompt: "p", answer: { choices: [1] } },
			{ type: "answers", prompt: "p", answers: [] },
			{ type: "answers", prompt: "p", answers: [1] },
			{ type: "cancel" },
			{ type: "focus", room: 4 },
		])
			expect(
				parseClientFrame(typeof bad === "string" ? bad : JSON.stringify(bad)),
			).toBeUndefined();
	});
});
