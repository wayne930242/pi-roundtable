import { expect, test } from "bun:test";
import { parseClientFrame } from "./protocol.ts";

test("parses each client frame and keeps only its known fields", () => {
	expect(parseClientFrame('{"type":"auth","token":"t"}')).toEqual({
		type: "auth",
		token: "t",
	});
	expect(
		parseClientFrame(
			JSON.stringify({
				type: "send",
				id: "1",
				persona: "helper",
				text: "hi",
				x: 1,
			}),
		),
	).toEqual({ type: "send", id: "1", persona: "helper", text: "hi" });
	expect(
		parseClientFrame(
			new TextEncoder().encode(
				JSON.stringify({ type: "send", id: "2", conversation: "c", text: "" }),
			),
		),
	).toEqual({ type: "send", id: "2", conversation: "c", text: "" });
	expect(parseClientFrame('{"type":"stop","conversation":"c"}')).toEqual({
		type: "stop",
		conversation: "c",
	});
	expect(
		parseClientFrame('{"type":"approval","prompt":"p","approved":false}'),
	).toEqual({ type: "approval", prompt: "p", approved: false });
	expect(
		parseClientFrame(
			'{"type":"answer","prompt":"p","choices":["a"],"text":"mine"}',
		),
	).toEqual({ type: "answer", prompt: "p", choices: ["a"], text: "mine" });
});

test("refuses malformed frames instead of guessing", () => {
	for (const raw of [
		"not json",
		"[]",
		"null",
		'{"type":"auth"}',
		'{"type":"auth","token":""}',
		'{"type":"send","id":"1","text":"hi"}',
		'{"type":"send","id":"","persona":"p","text":"hi"}',
		`{"type":"send","id":"${"x".repeat(129)}","persona":"p","text":"hi"}`,
		'{"type":"send","id":"1","persona":"p","text":5}',
		'{"type":"stop"}',
		'{"type":"approval","prompt":"p","approved":"yes"}',
		'{"type":"answer","prompt":"p","choices":[1]}',
		'{"type":"answer","prompt":"p","choices":[],"text":3}',
		'{"type":"fresh"}',
	])
		expect(parseClientFrame(raw)).toBeUndefined();
});
