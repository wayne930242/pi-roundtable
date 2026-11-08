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
		expect(
			parse({ type: "edit_queued", room: "r", message: 4, text: "new" }),
		).toEqual({ type: "edit_queued", room: "r", message: 4, text: "new" });
		expect(parse({ type: "cancel_queued", room: "r", message: 4 })).toEqual({
			type: "cancel_queued",
			room: "r",
			message: 4,
		});
		for (const bad of [
			{ type: "cancel_queued", room: "r", message: 0 },
			{ type: "cancel_queued", room: "r", message: 1.5 },
			{ type: "cancel_queued", room: "r", message: "4" },
			{ type: "edit_queued", room: "r", message: 4 },
			{ type: "edit_queued", room: "", message: 4, text: "x" },
		])
			expect(parse(bad)).toBeUndefined();
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

	test("an answer to a block parses to the kind and the pairs, and nothing the page adds", () => {
		expect(
			parse({
				type: "block_answer",
				id: "b1",
				room: "app:agent.guide",
				message: 7,
				block: 0,
				answer: {
					kind: "form",
					title: "ignored",
					ref: { block: 9 },
					fields: [["store", "sqlite"]],
				},
			}),
		).toEqual({
			type: "block_answer",
			id: "b1",
			room: "app:agent.guide",
			message: 7,
			block: 0,
			answer: { kind: "form", fields: [["store", "sqlite"]] },
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
			...[
				{ message: 0 },
				{ message: 1.5 },
				{ block: -1 },
				{ block: "0" },
				{ answer: { kind: "hover", fields: [] } },
				{ answer: { kind: "form", fields: [["a"]] } },
				{ answer: { kind: "form", fields: [["a", 1]] } },
				{ answer: { kind: "form" } },
				{ answer: { kind: "form", fields: Array(513).fill(["a", "b"]) } },
				{ id: "" },
			].map((bad) => ({
				type: "block_answer",
				id: "b1",
				room: "r",
				message: 7,
				block: 0,
				answer: { kind: "pick", fields: [["picked", "A"]] },
				...bad,
			})),
		])
			expect(
				parseClientFrame(typeof bad === "string" ? bad : JSON.stringify(bad)),
			).toBeUndefined();
	});
});
