import { afterAll, beforeAll, expect, test } from "bun:test";
import type { ClientFrame, ServerFrame } from "../src/api-types.ts";
import { openPage, releaseDom, type TestPage } from "./dom.ts";
import { answerBlock } from "./lib/block-answers.ts";
import { AppConnection } from "./lib/socket.ts";

/** A WebSocket the test drives: it records what the page sends and plays the server's frames. */
class FakeSocket {
	static all: FakeSocket[] = [];
	static readonly OPEN = 1;
	readyState = 1;
	sent: ClientFrame[] = [];
	onopen: (() => void) | null = null;
	onmessage: ((event: { data: string }) => void) | null = null;
	onclose: ((event: { code: number }) => void) | null = null;
	constructor() {
		FakeSocket.all.push(this);
	}
	send(raw: string) {
		this.sent.push(JSON.parse(raw) as ClientFrame);
	}
	close() {
		this.readyState = 3;
	}
	says(frame: ServerFrame) {
		this.onmessage?.({ data: JSON.stringify(frame) });
	}
}

let page: TestPage;
let original: unknown;
const started: AppConnection[] = [];
beforeAll(async () => {
	page = await openPage();
	original = Reflect.get(globalThis, "WebSocket");
	Reflect.set(globalThis, "WebSocket", FakeSocket);
});
afterAll(async () => {
	// A connection left running would fetch and reconnect inside the next test file.
	for (const connection of started) connection.stop();
	Reflect.set(globalThis, "WebSocket", original);
	await page.unmount();
	await releaseDom();
});

const ANSWER = { kind: "pick", fields: [["picked", "A"]] } as never;
const scope = (block = 0) => ({
	message: { id: 7, room: "app:agent.guide" } as never,
	open: true,
	block,
});
const opened = () => {
	const connection = new AppConnection("test");
	connection.start();
	started.push(connection);
	const socket = FakeSocket.all.at(-1) as FakeSocket;
	socket.onopen?.();
	return { connection, socket };
};

test("an answer to a block goes out as a block_answer frame and resolves when the server takes it", async () => {
	const { connection, socket } = opened();
	const pending = answerBlock(connection, scope(), 2, ANSWER);
	expect(socket.sent).toHaveLength(1);
	const frame = socket.sent[0] as Extract<
		ClientFrame,
		{ type: "block_answer" }
	>;
	expect(frame).toMatchObject({
		type: "block_answer",
		room: "app:agent.guide",
		message: 7,
		block: 2,
		answer: ANSWER,
	});
	socket.says({
		type: "accepted",
		id: frame.id,
		room: "app:agent.guide",
		// The page's store takes this frame, so the message is whole: other files read the same store.
		message: {
			id: 9,
			room: "app:agent.guide",
			kind: "owner",
			author: "Ada",
			text: "User picked A.",
			files: [],
			at: "2026-11-08T04:00:00.000Z",
		},
	});
	expect(await pending).toEqual({ ok: true });
	connection.stop();
});

test("a refusal resolves with its code, the reason and the fields that answered the block", async () => {
	const { connection, socket } = opened();
	const pending = answerBlock(connection, scope(), 0, ANSWER);
	const id = (socket.sent[0] as { id: string }).id;
	socket.says({
		type: "block_refused",
		id,
		room: "app:agent.guide",
		message: 7,
		block: 0,
		code: "answered",
		fields: [["picked", "B"]],
	});
	expect(await pending).toEqual({
		ok: false,
		code: "answered",
		reason: undefined,
		fields: [["picked", "B"]],
	});
	const gated = answerBlock(connection, scope(), 1, ANSWER);
	socket.says({
		type: "refused",
		id: (socket.sent[1] as { id: string }).id,
		code: "gated",
	});
	expect(await gated).toMatchObject({ ok: false, code: "gated" });
	connection.stop();
});

test("another frame's id does not settle an answer, and a socket that closes or is not open refuses it as not accepted", async () => {
	const { connection, socket } = opened();
	const pending = answerBlock(connection, scope(), 0, ANSWER);
	socket.says({ type: "refused", id: "someone-else", code: "empty" });
	let settled = false;
	pending.then(() => {
		settled = true;
	});
	await Bun.sleep(10);
	expect(settled).toBe(false);
	socket.onclose?.({ code: 1006 });
	expect(await pending).toEqual({ ok: false, code: "not_accepted" });
	// With no open socket nothing is sent.
	expect(await answerBlock(connection, scope(), 0, ANSWER)).toEqual({
		ok: false,
		code: "not_accepted",
	});
	connection.stop();
});
