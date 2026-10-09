import { expect, test } from "bun:test";
import { PiSandboxBroker } from "./pi-broker.ts";
import type { PiTurnRequest } from "./pi-protocol.ts";

const post = (path: string, body: unknown) =>
	new Request(`http://broker${path}`, {
		method: "POST",
		body: JSON.stringify(body),
	});
const turn: PiTurnRequest = {
	turnId: "a",
	author: { id: "ann", name: "Ann", principalId: "ann" },
	text: "hi",
	memory: "",
	images: [],
	thinking: "low",
};
function fixture(privateTool = false) {
	let providers = 0;
	const broker = new PiSandboxBroker({
		model: "host-model",
		workerImage: "sandbox:old",
		oauthToken: () => "offline",
		fetchImpl: async () => {
			providers++;
			return Response.json({});
		},
		tools: {
			names: ["recall"],
			call: async () =>
				privateTool
					? { ok: true, text: "SECRET", privateTo: "ann" }
					: { ok: true, text: "public" },
		},
	});
	const controller = new AbortController();
	const release = broker.bind({
		channel: "fake:party",
		profile: "test",
		speaker: turn.author,
		thinking: "low",
		signal: controller.signal,
	});
	return {
		broker,
		controller,
		providers: () => providers,
		close: () => {
			controller.abort();
			release();
		},
	};
}

test("sandbox capabilities are demand-driven: legacy public turns and tools still run", async () => {
	const f = fixture();
	try {
		expect((await f.broker.handle(post("/worker/ready", {}))).status).toBe(200);
		const done = f.broker.execute(
			{ ...turn, memory: "party-wide facts", memoryVisibility: "shared" },
			f.controller.signal,
		);
		expect(
			(await f.broker.handle(new Request("http://broker/worker/next"))).status,
		).toBe(200);
		expect(
			(await f.broker.handle(post("/tools/recall", { input: {} }))).status,
		).toBe(200);
		await f.broker.handle(
			post("/worker/result", {
				turnId: "a",
				result: { ok: true, text: "ok", files: [] },
			}),
		);
		expect((await done).ok).toBe(true);
	} finally {
		f.close();
	}
});

test("sandbox refuses old worker images before sending private prompts or replaying known private history", async () => {
	for (const privateHistory of [false, true]) {
		const f = fixture();
		try {
			await f.broker.handle(post("/worker/ready", { privateHistory }));
			await expect(
				f.broker.execute(
					{ ...turn, memory: privateHistory ? "" : "PRIVATE PROMPT" },
					AbortSignal.timeout(100),
				),
			).rejects.toThrow(/sandbox:old.*privateTo.*readerRecords.*rebuild/i);
			expect(f.providers()).toBe(0);
		} finally {
			f.close();
		}
	}
});

for (const capabilities of [{}, { privateTo: true }, { readerRecords: true }])
	test(`sandbox never releases a private tool payload without both worker capabilities ${JSON.stringify(capabilities)}`, async () => {
		const f = fixture(true);
		try {
			await f.broker.handle(post("/worker/ready", { capabilities }));
			const done = f.broker.execute(turn, AbortSignal.timeout(100));
			// Observe rejection immediately, before making the tool call that settles it.
			const failed = done.then(
				() => undefined,
				(error: unknown) => error,
			);
			await f.broker.handle(new Request("http://broker/worker/next"));
			const response = await f.broker.handle(
				post("/tools/recall", { input: {} }),
			);
			expect(response.status).toBe(409);
			expect(await response.text()).not.toContain("SECRET");
			const error = await failed;
			expect(error instanceof Error && error.message).toMatch(
				/sandbox:old.*rebuild/i,
			);
			expect(
				(
					await f.broker.handle(
						post("/anthropic/v1/messages", {
							messages: [{ role: "user", content: "hi" }],
						}),
					)
				).status,
			).toBe(410);
			expect(f.providers()).toBe(0);
		} finally {
			f.close();
		}
	});

test("sandbox capability downgrade invalidates an already queued private turn", async () => {
	const f = fixture();
	try {
		await f.broker.handle(
			post("/worker/ready", {
				capabilities: { privateTo: true, readerRecords: true },
			}),
		);
		const done = f.broker.execute(
			{ ...turn, memory: "PRIVATE PROMPT" },
			AbortSignal.timeout(100),
		);
		const failed = done.then(
			() => undefined,
			(error: unknown) => error,
		);
		await f.broker.handle(post("/worker/ready", {}));
		const error = await failed;
		expect(error instanceof Error && error.message).toMatch(
			/sandbox:old.*rebuild/i,
		);
		expect(f.providers()).toBe(0);
		expect(
			(
				await f.broker.handle(
					post("/worker/result", {
						turnId: "a",
						result: { ok: true, text: "ignored", files: [] },
					}),
				)
			).status,
		).toBe(409);
	} finally {
		f.close();
	}
});

test("sandbox ready handshake validates capability shapes and upgraded workers preserve privateTo", async () => {
	const f = fixture(true);
	try {
		expect(
			(
				await f.broker.handle(
					post("/worker/ready", { capabilities: { privateTo: "true" } }),
				)
			).status,
		).toBe(400);
		expect(f.broker.isReady()).toBe(false);
		await f.broker.handle(
			post("/worker/ready", {
				capabilities: { privateTo: true, readerRecords: true },
			}),
		);
		const response = await f.broker.handle(
			post("/tools/recall", { input: {} }),
		);
		expect(await response.json()).toMatchObject({
			privateTo: "ann",
			text: "SECRET",
		});
	} finally {
		f.close();
	}
});
