import { expect, test } from "bun:test";
import { recordingLogger } from "pi-roundtable/testing";
import { PiSandboxBroker } from "./pi-broker.ts";
import { bound, message, post } from "./testing/pi-broker-fixture.ts";

test("upstream errors keep status, body and back-off headers; credentials still never leave", async () => {
	const replies = [
		new Response(
			'{"error":{"message":"prompt is too long: 213462 tokens > 200000 maximum"}}',
			{
				status: 400,
				headers: {
					"content-type": "application/json",
					"set-cookie": "a=b",
					"request-id": "req_1",
				},
			},
		),
		new Response("{}", {
			status: 429,
			headers: {
				"retry-after": "17",
				"anthropic-ratelimit-unified-status": "rejected",
				"x-internal": "no",
			},
		}),
		new Response("expired", { status: 404 }),
		new Response("host-secret", { status: 500 }),
	];
	const broker = new PiSandboxBroker({
		model: "host-model",
		oauthToken: () => "host-secret",
		mcp: {
			servers: [{ name: "pika", url: "https://mcp.example.test/x", tools: [] }],
			token: () => "mcp-secret",
		},
		fetchImpl: async () => replies.shift() as Response,
	});
	const { release } = bound(broker);
	const tooLong = await broker.handle(post("/anthropic/v1/messages", message));
	expect(tooLong.status).toBe(400);
	expect(await tooLong.text()).toContain("prompt is too long");
	expect(tooLong.headers.get("request-id")).toBe("req_1");
	expect(tooLong.headers.get("set-cookie")).toBeNull();
	const limited = await broker.handle(post("/anthropic/v1/messages", message));
	expect(limited.status).toBe(429);
	expect(limited.headers.get("retry-after")).toBe("17");
	expect(limited.headers.get("anthropic-ratelimit-unified-status")).toBe(
		"rejected",
	);
	expect(limited.headers.get("x-internal")).toBeNull();
	await limited.text();
	const expired = await broker.handle(
		post("/mcp/pika", { jsonrpc: "2.0", id: 1, method: "ping" }),
	);
	expect(expired.status).toBe(404);
	await expired.text();
	const reflected = await broker.handle(
		post("/anthropic/v1/messages", message),
	);
	await expect(reflected.text()).rejects.toThrow();
	release();
});

const compactRequest = {
	reason: "threshold",
	tokensBefore: 310_000,
	firstKeptEntryId: "kept",
	isSplitTurn: false,
	messagesToSummarize: [],
	turnPrefixMessages: [],
	keptMessages: [],
	readFiles: [],
	modifiedFiles: [],
};

test("a host compactor gets at most half the turn's time left, so Pi's summary still fits", async () => {
	const recorder = recordingLogger();
	const signals: AbortSignal[] = [];
	const broker = new PiSandboxBroker({
		model: "host-model",
		oauthToken: () => "host-secret",
		logger: recorder.logger,
		compaction: {
			engine: "host-compactor",
			timeoutMs: 120_000,
			compact: (_request, { signal }) => {
				signals.push(signal);
				return new Promise(() => {});
			},
		},
	});
	const turn = new AbortController();
	const bind = (deadline: number) =>
		broker.bind({
			channel: "discord:channel",
			profile: "profile",
			speaker: { id: "guest", name: "Guest" },
			thinking: "low",
			signal: turn.signal,
			deadline,
		});
	// Under two seconds left: no time for the compactor at all.
	let release = bind(Date.now() + 1500);
	const late = await broker.handle(post("/compaction/compact", compactRequest));
	expect(await late.json()).toEqual({
		ok: false,
		fallback: "the turn has too little time left for the host compactor",
	});
	expect(signals).toHaveLength(0);
	release();
	// Four seconds left: the compactor gets two, not its own 120.
	release = bind(Date.now() + 4000);
	const started = Date.now();
	const cut = (await (
		await broker.handle(post("/compaction/compact", compactRequest))
	).json()) as { ok: boolean; fallback: string };
	expect(cut.ok).toBe(false);
	expect(cut.fallback).toMatch(/^the compactor took over (19\d\d|2000) ms$/);
	expect(Date.now() - started).toBeLessThan(3000);
	expect(signals[0]?.aborted).toBe(true);
	release();
}, 10_000);

test("an error event in the middle of a 200 stream is logged, and the worker still gets the stream", async () => {
	const recorder = recordingLogger();
	const stream =
		'event: message_start\ndata: {"type":"message_start"}\n\n' +
		'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded host-secret"}}\n\n';
	const broker = new PiSandboxBroker({
		model: "host-model",
		oauthToken: () => "host-secret",
		logger: recorder.logger,
		fetchImpl: async () =>
			new Response(
				// Split mid-event, as a network would.
				new ReadableStream({
					start(controller) {
						const bytes = new TextEncoder().encode(
							stream.replace(" host-secret", ""),
						);
						controller.enqueue(bytes.subarray(0, 70));
						controller.enqueue(bytes.subarray(70));
						controller.close();
					},
				}),
				{ status: 200, headers: { "content-type": "text/event-stream" } },
			),
	});
	const { release } = bound(broker);
	const response = await broker.handle(post("/anthropic/v1/messages", message));
	expect(response.status).toBe(200);
	expect(await response.text()).toContain("overloaded_error");
	const failures = recorder.lines.filter(
		(line) => line.message === "sandbox upstream call failed",
	);
	expect(failures).toHaveLength(1);
	expect(failures[0]?.fields).toMatchObject({ status: 200 });
	expect(String(failures[0]?.fields.body)).toContain(
		'stream error event: {"type":"error","error":{"type":"overloaded_error"',
	);
	release();
});

test("subscription token is resolved per model call from the bound channel and speaker", async () => {
	const scopes: unknown[] = [];
	const seen: (string | null)[] = [];
	const broker = new PiSandboxBroker({
		model: "host-model",
		oauthToken: (scope) => {
			scopes.push(scope);
			return scope.channel === "discord:alpha" ? "alpha-secret" : "beta-secret";
		},
		fetchImpl: async (_url, init) => {
			seen.push(new Headers(init.headers).get("authorization"));
			return Response.json({ content: "ok" });
		},
	});
	for (const [channel, id] of [
		["discord:alpha", "guest-a"],
		["discord:beta", "guest-b"],
	] as const) {
		const release = broker.bind({
			channel,
			profile: "profile",
			speaker: { id, name: id },
			thinking: "high",
			signal: new AbortController().signal,
		});
		expect(
			(await broker.handle(post("/anthropic/v1/messages", message))).status,
		).toBe(200);
		release();
	}
	expect(seen).toEqual(["Bearer alpha-secret", "Bearer beta-secret"]);
	expect(scopes).toEqual([
		{ channel: "discord:alpha", speaker: { id: "guest-a", name: "guest-a" } },
		{ channel: "discord:beta", speaker: { id: "guest-b", name: "guest-b" } },
	]);
});

test("a request in flight keeps its own turn's token after the next turn binds", async () => {
	let sendBody!: () => void;
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			sendBody = () => {
				controller.enqueue(new TextEncoder().encode(JSON.stringify(message)));
				controller.close();
			};
		},
	});
	const scopes: string[] = [];
	const seen: (string | null)[] = [];
	const broker = new PiSandboxBroker({
		model: "host-model",
		oauthToken: (scope) => {
			scopes.push(scope.channel);
			return scope.channel === "discord:alpha" ? "alpha-secret" : "beta-secret";
		},
		fetchImpl: async (_url, init) => {
			seen.push(new Headers(init.headers).get("authorization"));
			return Response.json({ content: "ok" });
		},
	});
	const turn = (channel: "discord:alpha" | "discord:beta", id: string) =>
		broker.bind({
			channel,
			profile: "profile",
			speaker: { id, name: id },
			thinking: "high",
			signal: new AbortController().signal,
		});
	const releaseA = turn("discord:alpha", "guest-a");
	// The body arrives only after turn A ends and turn B binds, so the token is resolved while B is bound.
	const inFlight = broker.handle(
		new Request("http://broker/anthropic/v1/messages", {
			method: "POST",
			headers: { authorization: "Bearer guest-token" },
			body,
			duplex: "half",
		} as RequestInit),
	);
	await Bun.sleep(0);
	releaseA();
	const releaseB = turn("discord:beta", "guest-b");
	sendBody();
	expect((await inFlight).status).toBe(200);
	expect(
		(await broker.handle(post("/anthropic/v1/messages", message))).status,
	).toBe(200);
	releaseB();
	expect(scopes).toEqual(["discord:alpha", "discord:beta"]);
	expect(seen).toEqual(["Bearer alpha-secret", "Bearer beta-secret"]);
});

for (const missing of [undefined, ""]) {
	test(`a subscription getter returning ${JSON.stringify(missing)} fails the call without reaching upstream`, async () => {
		let fetched = 0;
		const broker = new PiSandboxBroker({
			model: "host-model",
			oauthToken: () => missing,
			fetchImpl: async () => {
				fetched += 1;
				return Response.json({ content: "ok" });
			},
		});
		const release = broker.bind({
			channel: "discord:alpha",
			profile: "profile",
			speaker: { id: "guest-a", name: "guest-a" },
			thinking: "high",
			signal: new AbortController().signal,
		});
		const response = await broker.handle(
			post("/anthropic/v1/messages", message),
		);
		release();
		expect(response.status).toBe(502);
		expect(fetched).toBe(0);
	});
}
