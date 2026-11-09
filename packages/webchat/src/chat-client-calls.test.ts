import { expect, test } from "bun:test";
import { linked } from "./testing/chat-fixture.ts";
import { TEST_LIMITS } from "./testing/fakes.ts";

test("a turn carries the origin its connection opened with, and none for a connection that had none", async () => {
	const { connect, say, turns, settled } = await linked();
	const ada = connect("ada", ["User"], "ada", "https://chat.example.com");
	const bob = connect("bob");
	// The message text is the person's; it never decides the origin.
	await say(ada, {
		type: "send",
		id: "c1",
		persona: "helper",
		text: "origin: https://evil.example.com",
	});
	await say(bob, { type: "send", id: "c2", persona: "helper", text: "hi" });
	await settled();
	expect(turns.map((turn) => turn.origin)).toEqual([
		"https://chat.example.com",
		undefined,
	]);
	expect(turns[1]).not.toHaveProperty("origin");
});

test("ready tells a client the limits of the calls it may be asked to run", async () => {
	const { connect } = await linked();
	const ada = connect("ada");
	expect(ada.frames[0]).toMatchObject({
		type: "ready",
		clientCalls: {
			timeoutMs: TEST_LIMITS.clientCalls.timeoutMs,
			maxTimeoutMs: TEST_LIMITS.clientCalls.maxTimeoutMs,
			maxValueBytes: TEST_LIMITS.clientCalls.maxValueBytes,
			maxParts: TEST_LIMITS.clientCalls.maxParts,
			maxPartBytes: TEST_LIMITS.clientCalls.maxPartBytes,
		},
	});
	expect(ada.frames[0]).not.toHaveProperty("clientCalls.perMinute");
});

test("a turn gets a client only from a connection that declared functions, and the client names them", async () => {
	const { connect, say, turns, settled } = await linked();
	const declared = connect("ada");
	const silent = connect("bob");
	await say(declared, {
		type: "client_hello",
		version: 1,
		tools: ["page_status"],
	});
	await say(declared, {
		type: "send",
		id: "c1",
		persona: "helper",
		text: "hi",
	});
	await say(silent, { type: "send", id: "c2", persona: "helper", text: "hi" });
	await settled();
	expect(turns[0]?.client?.names).toEqual(["page_status"]);
	expect(turns[1]).not.toHaveProperty("client");
});

test("a call goes to the connection that started the turn only, and another connection of the same person cannot answer it", async () => {
	let outcome: unknown;
	const ctx = await linked("done", async (input) => {
		outcome = await input.client?.call("page_status", { a: 1 });
	});
	const { connect, say, settled } = ctx;
	const first = connect("ada");
	const second = connect("ada");
	await say(first, {
		type: "client_hello",
		version: 1,
		tools: ["page_status"],
	});
	await say(second, {
		type: "client_hello",
		version: 1,
		tools: ["page_status"],
	});
	await say(first, { type: "send", id: "c1", persona: "helper", text: "hi" });
	for (
		let n = 0;
		n < 100 && !first.frames.some((f) => f.type === "client_call");
		n++
	)
		await Bun.sleep(5);
	const call = first.frames.find((f) => f.type === "client_call");
	if (call?.type !== "client_call") throw new Error("no call was sent");
	expect(call).toMatchObject({ name: "page_status", args: { a: 1 } });
	expect(second.frames.some((f) => f.type === "client_call")).toBe(false);
	await say(second, {
		type: "client_result",
		call: call.call,
		ok: true,
		value: 1,
	});
	expect(second.frames.at(-1)).toEqual({
		type: "error",
		code: "unknown_call",
		ref: call.call,
	});
	expect(outcome).toBeUndefined();
	await say(first, {
		type: "client_result",
		call: call.call,
		ok: true,
		value: 7,
	});
	await settled();
	expect(outcome).toMatchObject({ ok: true, value: 7 });
});

test("closing the connection that started the turn ends its call as disconnected", async () => {
	let outcome: unknown;
	const ctx = await linked("done", async (input) => {
		outcome = await input.client?.call("page_status", {});
	});
	const { connect, say, chat, settled } = ctx;
	const ada = connect("ada");
	await say(ada, { type: "client_hello", version: 1, tools: ["page_status"] });
	await say(ada, { type: "send", id: "c1", persona: "helper", text: "hi" });
	for (
		let n = 0;
		n < 100 && !ada.frames.some((f) => f.type === "client_call");
		n++
	)
		await Bun.sleep(5);
	chat.closed(ada);
	await settled();
	expect(outcome).toMatchObject({ ok: false, error: "disconnected" });
});

test("a call made after its turn ended finds no client", async () => {
	let port: { call(name: string, args: unknown): Promise<unknown> } | undefined;
	const ctx = await linked("done", async (input) => {
		port = input.client;
	});
	const { connect, say, settled } = ctx;
	const ada = connect("ada");
	await say(ada, { type: "client_hello", version: 1, tools: ["page_status"] });
	await say(ada, { type: "send", id: "c1", persona: "helper", text: "hi" });
	await settled();
	expect(await port?.call("page_status", {})).toMatchObject({
		ok: false,
		error: "no_client",
	});
});

test("a declaration that does not fit is refused, and a connection that declares nothing is unaffected", async () => {
	const { connect, say } = await linked();
	const ada = connect("ada");
	await say(ada, { type: "client_hello", version: 1, tools: ["Bad Name"] });
	expect(ada.frames.at(-1)).toEqual({ type: "error", code: "bad_frame" });
	await say(ada, { type: "client_result", call: "ghost", ok: true, value: 1 });
	expect(ada.frames.at(-1)).toEqual({
		type: "error",
		code: "unknown_call",
		ref: "ghost",
	});
});
