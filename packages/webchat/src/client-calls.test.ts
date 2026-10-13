import { describe, expect, test } from "bun:test";
import type { ClientCallResult } from "pi-roundtable";
import {
	type ClientCallLimits,
	ClientDesk,
	ClientPartRefusal,
} from "./client-calls.ts";
import type { Connection } from "./connections.ts";
import type { ServerFrame } from "./protocol.ts";
import { identity, speakerOf } from "./testing/fakes.ts";

const LIMITS: ClientCallLimits = {
	timeoutMs: 1000,
	maxTimeoutMs: 2000,
	maxValueBytes: 200,
	maxParts: 2,
	maxPartBytes: 64,
	perMinute: 10,
};

const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const PNG = Uint8Array.from([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0,
]);

function connection(
	id: string,
	tools: readonly string[] | null = ["page_status"],
	principalId = id,
): Connection {
	return {
		identity: identity(id),
		speaker: { ...speakerOf(id), principalId },
		...(tools ? { clientTools: tools } : {}),
		timers: [],
	};
}

function setup(limits: Partial<ClientCallLimits> = {}, now = () => 0) {
	const sent: { to: Connection; frame: ServerFrame }[] = [];
	const desk = new ClientDesk({
		limits: { ...LIMITS, ...limits },
		send: (to, frame) => void sent.push({ to, frame }),
		now,
	});
	const calls = () =>
		sent.flatMap(({ frame }) => (frame.type === "client_call" ? [frame] : []));
	const cancels = () =>
		sent.flatMap(({ frame }) =>
			frame.type === "client_cancel" ? [frame] : [],
		);
	return { desk, sent, calls, cancels };
}

/** Lets a call's frame go out before the test answers it. */
const tick = () => Bun.sleep(0);

const ok = (call: string, value: unknown = { fine: true }, parts?: number) =>
	({
		type: "client_result",
		call,
		ok: true,
		value,
		...(parts === undefined ? {} : { parts }),
	}) as const;

function put(body: Uint8Array | string, type: string | null) {
	return new Request("http://chat.test/x", {
		method: "PUT",
		headers: type ? { "content-type": type } : {},
		body,
	});
}

async function refusal(promise: Promise<unknown>) {
	try {
		await promise;
	} catch (error) {
		if (error instanceof ClientPartRefusal)
			return { status: error.status, code: error.code };
		throw error;
	}
	throw new Error("expected a ClientPartRefusal");
}

describe("the port of a turn", () => {
	test("exists only for a connection that declared functions", () => {
		const { desk } = setup();
		expect(desk.portFor(connection("ada", null), "c1")).toBeUndefined();
		expect(desk.portFor(connection("ada", []), "c1")).toBeUndefined();
		expect(desk.portFor(connection("ada"), "c1")?.names).toEqual([
			"page_status",
		]);
	});

	test("sends a call to the connection that started the turn and to no other, then returns the client's answer", async () => {
		const { desk, sent, calls } = setup();
		const started = connection("ada");
		const other = connection("ada", ["page_status"]);
		desk.portFor(other, "c9");
		const port = desk.portFor(started, "c1");
		const pending = port?.call("page_status", { a: 1 });
		await tick();
		expect(sent).toHaveLength(1);
		expect(sent[0]?.to).toBe(started);
		const [call] = calls();
		expect(call).toMatchObject({
			type: "client_call",
			conversation: "c1",
			name: "page_status",
			args: { a: 1 },
			timeoutMs: 1000,
		});
		expect(call?.call).toMatch(/^[0-9a-f-]{36}$/);
		expect(desk.result(started, ok(call?.call ?? "", { url: "u" }))).toBe(
			undefined,
		);
		expect(await pending).toEqual({
			ok: true,
			value: { url: "u" },
			parts: [],
		});
	});

	test("takes an answer only from the connection it was sent to, not from another connection of the same person or from someone else's", async () => {
		const { desk, calls } = setup();
		const started = connection("ada");
		const sameAda = connection("ada");
		const eve = connection("eve", ["page_status"], "ada");
		const bob = connection("bob");
		const pending = desk.portFor(started, "c1")?.call("page_status", {});
		await tick();
		const id = calls()[0]?.call ?? "";
		for (const intruder of [sameAda, eve, bob])
			expect(desk.result(intruder, ok(id))).toBe("unknown_call");
		let settled = false;
		void pending?.then(() => {
			settled = true;
		});
		await tick();
		expect(settled).toBe(false);
		expect(desk.result(started, ok(id, 1))).toBeUndefined();
		expect(await pending).toMatchObject({ ok: true, value: 1 });
	});

	test("refuses an answer to a call that is not open, or was answered already", async () => {
		const { desk, calls } = setup();
		const started = connection("ada");
		expect(desk.result(started, ok("nope"))).toBe("unknown_call");
		const pending = desk.portFor(started, "c1")?.call("page_status", {});
		await tick();
		const id = calls()[0]?.call ?? "";
		desk.result(started, ok(id));
		await pending;
		expect(desk.result(started, ok(id))).toBe("unknown_call");
	});

	test("turns a failure the client reports into the matching error, its message made plain and short", async () => {
		const { desk, calls } = setup();
		const started = connection("ada");
		const port = desk.portFor(started, "c1");
		const expected: [string, string][] = [
			["refused", "refused"],
			["failed", "failed"],
			["timeout", "timeout"],
			["stopped", "cancelled"],
		];
		for (const [code, error] of expected) {
			const pending = port?.call("page_status", {});
			await tick();
			const id = calls().at(-1)?.call ?? "";
			desk.result(started, {
				type: "client_result",
				call: id,
				ok: false,
				code: code as "refused",
				message: `bad\nthing\u202e${"x".repeat(1000)}`,
			});
			const result = await pending;
			expect(result).toMatchObject({ ok: false, error });
			const message = result && !result.ok ? result.message : "";
			expect(message).not.toContain("\n");
			expect(message).not.toContain("\u202e");
			expect(message.length).toBeLessThanOrEqual(300);
			expect(message).toStartWith("bad thing");
		}
	});

	test("ends a call the client does not answer in time as a timeout, and tells the client to stop", async () => {
		const { desk, calls, cancels } = setup();
		const port = desk.portFor(connection("ada"), "c1");
		const result = await port?.call("page_status", {}, { timeoutMs: 20 });
		expect(result).toMatchObject({ ok: false, error: "timeout" });
		expect(cancels()).toEqual([
			{
				type: "client_cancel",
				call: calls()[0]?.call ?? "",
				reason: "timeout",
			},
		]);
	});

	test("waits the default time and never past the longest the server allows", async () => {
		const { desk, calls } = setup({ timeoutMs: 700, maxTimeoutMs: 900 });
		const started = connection("ada");
		const port = desk.portFor(started, "c1");
		const answers: Promise<ClientCallResult>[] = [];
		for (const options of [
			undefined,
			{ timeoutMs: 5 },
			{ timeoutMs: 99_999 },
		]) {
			const pending = port?.call("page_status", {}, options);
			if (pending) answers.push(pending);
			await tick();
			desk.result(started, ok(calls().at(-1)?.call ?? ""));
			await pending;
		}
		expect(calls().map((call) => call.timeoutMs)).toEqual([700, 5, 900]);
	});

	test("cancels a call in flight when its signal aborts, and tells the client; an aborted signal sends nothing", async () => {
		const { desk, sent, calls, cancels } = setup();
		const port = desk.portFor(connection("ada"), "c1");
		const stop = new AbortController();
		const pending = port?.call("page_status", {}, { signal: stop.signal });
		await tick();
		stop.abort();
		expect(await pending).toMatchObject({ ok: false, error: "cancelled" });
		expect(cancels()).toEqual([
			{
				type: "client_cancel",
				call: calls()[0]?.call ?? "",
				reason: "turn_stopped",
			},
		]);
		const before = sent.length;
		expect(
			await port?.call("page_status", {}, { signal: stop.signal }),
		).toMatchObject({ ok: false, error: "cancelled" });
		expect(sent).toHaveLength(before);
		// The call is closed: a late answer finds nothing.
		expect(desk.result(connection("ada"), ok(calls()[0]?.call ?? ""))).toBe(
			"unknown_call",
		);
	});

	test("ends a call whose answer passes the byte limit as too_large, the call's own limit counting when lower", async () => {
		const { desk, calls } = setup();
		const started = connection("ada");
		const port = desk.portFor(started, "c1");
		const big = { text: "y".repeat(300) };
		const first = port?.call("page_status", {});
		await tick();
		desk.result(started, ok(calls().at(-1)?.call ?? "", big));
		expect(await first).toMatchObject({ ok: false, error: "too_large" });
		const small = { text: "y".repeat(50) };
		const second = port?.call("page_status", {}, { maxValueBytes: 20 });
		await tick();
		desk.result(started, ok(calls().at(-1)?.call ?? "", small));
		expect(await second).toMatchObject({ ok: false, error: "too_large" });
		const third = port?.call("page_status", {}, { maxValueBytes: 1_000_000 });
		await tick();
		desk.result(started, ok(calls().at(-1)?.call ?? "", big));
		expect(await third).toMatchObject({ ok: false, error: "too_large" });
		const fourth = port?.call("page_status", {}, { maxValueBytes: 100 });
		await tick();
		desk.result(started, ok(calls().at(-1)?.call ?? "", small));
		expect(await fourth).toMatchObject({ ok: true });
	});

	test("ends the open call as disconnected when the connection closes, and every later call too", async () => {
		const { desk } = setup();
		const started = connection("ada");
		const port = desk.portFor(started, "c1");
		const pending = port?.call("page_status", {});
		await tick();
		desk.closed(started);
		expect(await pending).toMatchObject({ ok: false, error: "disconnected" });
		expect(await port?.call("page_status", {})).toMatchObject({
			ok: false,
			error: "disconnected",
		});
		// A turn that starts on a connection already closed gets the same.
		expect(
			await desk.portFor(started, "c2")?.call("page_status", {}),
		).toMatchObject({ ok: false, error: "disconnected" });
	});

	test("holds one open call per connection: a second one meanwhile is busy, another connection's is not", async () => {
		const { desk, calls } = setup();
		const a = connection("ada");
		const b = connection("ada");
		const portA = desk.portFor(a, "c1");
		const first = portA?.call("page_status", {});
		await tick();
		expect(await portA?.call("page_status", {})).toMatchObject({
			ok: false,
			error: "busy",
		});
		const other = desk.portFor(b, "c2")?.call("page_status", {});
		await tick();
		expect(calls()).toHaveLength(2);
		desk.result(a, ok(calls()[0]?.call ?? ""));
		await first;
		const again = portA?.call("page_status", {});
		await tick();
		expect(calls()).toHaveLength(3);
		desk.result(a, ok(calls()[2]?.call ?? ""));
		desk.result(b, ok(calls()[1]?.call ?? ""));
		expect(await again).toMatchObject({ ok: true });
		expect(await other).toMatchObject({ ok: true });
	});

	test("allows each connection a number of calls a minute, and counts again as the window moves", async () => {
		let clock = 0;
		const { desk, calls } = setup({ perMinute: 3 }, () => clock);
		const started = connection("ada");
		const port = desk.portFor(started, "c1");
		for (let n = 0; n < 3; n++) {
			const pending = port?.call("page_status", {});
			await tick();
			desk.result(started, ok(calls().at(-1)?.call ?? ""));
			await pending;
		}
		expect(await port?.call("page_status", {})).toMatchObject({
			ok: false,
			error: "busy",
		});
		clock = 61_000;
		const pending = port?.call("page_status", {});
		await tick();
		desk.result(started, ok(calls().at(-1)?.call ?? ""));
		expect(await pending).toMatchObject({ ok: true });
	});

	test("refuses a function the client did not declare without sending it, and arguments that are not JSON or are too large", async () => {
		const { desk, sent } = setup();
		const port = desk.portFor(connection("ada"), "c1");
		expect(await port?.call("page_eval", {})).toMatchObject({
			ok: false,
			error: "refused",
		});
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		expect(await port?.call("page_status", cyclic)).toMatchObject({
			ok: false,
			error: "failed",
		});
		expect(
			await port?.call("page_status", { text: "z".repeat(40_000) }),
		).toMatchObject({ ok: false, error: "failed" });
		expect(sent).toEqual([]);
	});

	test("ends the open call when the turn ends, and answers no_client after", async () => {
		const { desk, calls, cancels } = setup();
		const port = desk.portFor(connection("ada"), "c1");
		const pending = port?.call("page_status", {});
		await tick();
		port?.end();
		expect(await pending).toMatchObject({ ok: false, error: "cancelled" });
		expect(cancels()[0]).toMatchObject({
			call: calls()[0]?.call,
			reason: "turn_ended",
		});
		expect(await port?.call("page_status", {})).toMatchObject({
			ok: false,
			error: "no_client",
		});
	});
});

describe("the binary parts of an answer", () => {
	async function open() {
		const state = setup();
		const started = connection("ada");
		const pending = state.desk.portFor(started, "c1")?.call("page_status", {});
		await tick();
		const call = state.calls()[0]?.call ?? "";
		return { ...state, started, pending, call };
	}

	test("arrive over REST before the answer and come back with it, in order", async () => {
		const { desk, started, pending, call } = await open();
		await desk.receivePart("ada", "c1", call, 1, put(PNG, "image/png"));
		await desk.receivePart("ada", "c1", call, 0, put(JPEG, "image/jpeg"));
		expect(desk.result(started, ok(call, "shot", 2))).toBeUndefined();
		const result = await pending;
		expect(result).toMatchObject({ ok: true, value: "shot" });
		expect(
			result?.ok && result.parts.map((part) => [part.mimeType, [...part.data]]),
		).toEqual([
			["image/jpeg", [...JPEG]],
			["image/png", [...PNG]],
		]);
	});

	test("are refused for a call that is not open, is another person's, or belongs to another conversation", async () => {
		const { desk, call } = await open();
		for (const [principal, conversation, id] of [
			["ada", "c1", "no-such-call"],
			["eve", "c1", call],
			["ada", "c2", call],
		] as const)
			expect(
				await refusal(
					desk.receivePart(
						principal,
						conversation,
						id,
						0,
						put(JPEG, "image/jpeg"),
					),
				),
			).toEqual({ status: 404, code: "unknown_call" });
	});

	test("are refused over the count, over the size, of a type that is not an image, with bytes that are not the type, or twice", async () => {
		const { desk, call } = await open();
		const again = (
			index: number,
			body: Uint8Array | string,
			type: string | null,
		) => desk.receivePart("ada", "c1", call, index, put(body, type));
		expect(await refusal(again(2, JPEG, "image/jpeg"))).toEqual({
			status: 400,
			code: "bad_request",
		});
		expect(
			await refusal(again(0, new Uint8Array(65).fill(0xff), "image/jpeg")),
		).toEqual({ status: 413, code: "payload_too_large" });
		expect(await refusal(again(0, "{}", "application/json"))).toEqual({
			status: 415,
			code: "unsupported_media_type",
		});
		expect(await refusal(again(0, "{}", null))).toEqual({
			status: 415,
			code: "unsupported_media_type",
		});
		expect(await refusal(again(0, PNG, "image/jpeg"))).toEqual({
			status: 415,
			code: "unsupported_media_type",
		});
		await again(0, JPEG, "image/jpeg; charset=binary");
		expect(await refusal(again(0, JPEG, "image/jpeg"))).toEqual({
			status: 409,
			code: "duplicate_part",
		});
	});

	test("a part already being read refuses a second upload of the same index at once", async () => {
		const { desk, call } = await open();
		let release: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const slow = new Request("http://chat.test/x", {
			method: "PUT",
			headers: { "content-type": "image/jpeg" },
			body: new ReadableStream({
				async pull(controller) {
					await gate;
					controller.enqueue(JPEG);
					controller.close();
				},
			}),
			duplex: "half",
		} as RequestInit);
		const first = desk.receivePart("ada", "c1", call, 0, slow);
		await tick();
		const second = new Request("http://chat.test/x", {
			method: "PUT",
			headers: { "content-type": "image/jpeg" },
			body: new ReadableStream({
				pull(controller) {
					controller.enqueue(JPEG);
					controller.close();
				},
			}),
			duplex: "half",
		} as RequestInit);
		expect(
			await refusal(desk.receivePart("ada", "c1", call, 0, second)),
		).toEqual({ status: 409, code: "duplicate_part" });
		release();
		await first;
		// The index is free again for a failed read, and taken for a good one.
		expect(
			await refusal(
				desk.receivePart("ada", "c1", call, 0, put(JPEG, "image/jpeg")),
			),
		).toEqual({ status: 409, code: "duplicate_part" });
	});

	test("an index whose read failed can be uploaded again", async () => {
		const { desk, call } = await open();
		expect(
			await refusal(
				desk.receivePart("ada", "c1", call, 0, put(PNG, "image/jpeg")),
			),
		).toEqual({ status: 415, code: "unsupported_media_type" });
		await desk.receivePart("ada", "c1", call, 0, put(JPEG, "image/jpeg"));
	});

	test("an answer declaring more parts than the limit says so", async () => {
		const state = await open();
		await state.desk.receivePart(
			"ada",
			"c1",
			state.call,
			0,
			put(JPEG, "image/jpeg"),
		);
		state.desk.result(state.started, ok(state.call, "x", 3));
		const result = await state.pending;
		expect(result).toMatchObject({ ok: false, error: "failed" });
		expect(result?.ok === false && result.message).toContain("limit of 2");
	});

	test("are refused as soon as the declared length is over the limit, without reading the body", async () => {
		const { desk, call } = await open();
		const request = new Request("http://chat.test/x", {
			method: "PUT",
			headers: { "content-type": "image/jpeg", "content-length": "99999" },
			body: JPEG,
		});
		expect(
			await refusal(desk.receivePart("ada", "c1", call, 0, request)),
		).toEqual({
			status: 413,
			code: "payload_too_large",
		});
	});

	test("must all have arrived for an answer to count them", async () => {
		const first = await open();
		await first.desk.receivePart(
			"ada",
			"c1",
			first.call,
			0,
			put(JPEG, "image/jpeg"),
		);
		first.desk.result(first.started, ok(first.call, "x", 2));
		expect(await first.pending).toMatchObject({ ok: false, error: "failed" });
		const second = await open();
		second.desk.result(second.started, ok(second.call, "x", 3));
		expect(await second.pending).toMatchObject({ ok: false, error: "failed" });
	});

	test("that no answer claims are dropped, and a call that ended takes no more", async () => {
		const { desk, started, pending, call } = await open();
		await desk.receivePart("ada", "c1", call, 0, put(JPEG, "image/jpeg"));
		desk.result(started, ok(call, "x"));
		expect(await pending).toEqual({ ok: true, value: "x", parts: [] });
		expect(
			await refusal(
				desk.receivePart("ada", "c1", call, 0, put(JPEG, "image/jpeg")),
			),
		).toEqual({ status: 404, code: "unknown_call" });
	});
});
