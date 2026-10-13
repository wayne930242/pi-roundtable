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

test("a send frame may reference uploaded files, which are checked as plain strings", () => {
	expect(
		parseClientFrame(
			JSON.stringify({
				type: "send",
				id: "1",
				conversation: "c",
				text: "see",
				attachments: ["f1-screenshot.png", "f2-session.json"],
			}),
		),
	).toEqual({
		type: "send",
		id: "1",
		conversation: "c",
		text: "see",
		attachments: ["f1-screenshot.png", "f2-session.json"],
	});
	expect(
		parseClientFrame(
			'{"type":"send","id":"1","conversation":"c","text":"see","attachments":[]}',
		),
	).toEqual({ type: "send", id: "1", conversation: "c", text: "see" });
	const bad = (attachments: unknown) =>
		parseClientFrame(
			JSON.stringify({
				type: "send",
				id: "1",
				conversation: "c",
				text: "see",
				attachments,
			}),
		);
	expect(bad("f1")).toBeUndefined();
	expect(bad([1])).toBeUndefined();
	expect(bad([""])).toBeUndefined();
	expect(bad(["x".repeat(201)])).toBeUndefined();
	expect(bad(Array.from({ length: 33 }, (_, i) => `f${i}`))).toBeUndefined();
});

test("parses a client's declaration and its answers, keeping only their known fields", () => {
	expect(
		parseClientFrame(
			'{"type":"client_hello","version":1,"tools":["page_status","page_click","page_click"],"x":1}',
		),
	).toEqual({
		type: "client_hello",
		version: 1,
		tools: ["page_status", "page_click"],
	});
	expect(
		parseClientFrame(
			'{"type":"client_result","call":"k1","ok":true,"value":{"a":[1]},"parts":2,"x":1}',
		),
	).toEqual({
		type: "client_result",
		call: "k1",
		ok: true,
		value: { a: [1] },
		parts: 2,
	});
	expect(
		parseClientFrame('{"type":"client_result","call":"k1","ok":true}'),
	).toEqual({ type: "client_result", call: "k1", ok: true, value: null });
	expect(
		parseClientFrame(
			'{"type":"client_result","call":"k1","ok":false,"code":"stopped","message":"the person stopped it"}',
		),
	).toEqual({
		type: "client_result",
		call: "k1",
		ok: false,
		code: "stopped",
		message: "the person stopped it",
	});
	expect(
		parseClientFrame(
			'{"type":"client_result","call":"k1","ok":false,"code":"failed"}',
		),
	).toEqual({ type: "client_result", call: "k1", ok: false, code: "failed" });
});

test("refuses a declaration or an answer that does not fit", () => {
	for (const raw of [
		'{"type":"client_hello","tools":["a"]}',
		'{"type":"client_hello","version":2,"tools":["a"]}',
		'{"type":"client_hello","version":1}',
		'{"type":"client_hello","version":1,"tools":"a"}',
		'{"type":"client_hello","version":1,"tools":["Page"]}',
		'{"type":"client_hello","version":1,"tools":["bad name"]}',
		'{"type":"client_hello","version":1,"tools":[1]}',
		`{"type":"client_hello","version":1,"tools":[${Array.from({ length: 65 }, (_, i) => `"t${i}"`).join(",")}]}`,
		`{"type":"client_hello","version":1,"tools":["${"a".repeat(65)}"]}`,
		'{"type":"client_result","ok":true}',
		'{"type":"client_result","call":"","ok":true}',
		'{"type":"client_result","call":"k1"}',
		'{"type":"client_result","call":"k1","ok":"yes"}',
		'{"type":"client_result","call":"k1","ok":true,"parts":-1}',
		'{"type":"client_result","call":"k1","ok":true,"parts":1.5}',
		'{"type":"client_result","call":"k1","ok":true,"parts":99}',
		'{"type":"client_result","call":"k1","ok":false}',
		'{"type":"client_result","call":"k1","ok":false,"code":"too_large"}',
		'{"type":"client_result","call":"k1","ok":false,"code":"failed","message":5}',
		'{"type":"client_result","call":"k1","ok":false,"code":"failed","message":"' +
			"x".repeat(2001) +
			'"}',
	])
		expect(parseClientFrame(raw)).toBeUndefined();
});
