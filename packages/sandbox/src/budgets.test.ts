import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { unixBrokerRequest } from "../worker/transport.ts";
import { SandboxRuntime, type SandboxRuntimeOptions } from "./runtime.ts";
import { resolveSandboxRuntimeOptions } from "./runtime-options.ts";

const speaker = { id: "guest", name: "Guest", principalId: "p_guest" };

function options(
	root: string,
	extra: Partial<SandboxRuntimeOptions> = {},
): SandboxRuntimeOptions {
	return {
		image: "sandbox:fake",
		runRoot: join(root, "run"),
		workspaceRoot: join(root, "work"),
		model: "fake",
		modelUrl: "https://models.example/chat",
		apiKey: () => "host-key",
		driver: { run: async () => ({ ok: true, text: "done" }) },
		...extra,
	};
}

test.each([
	[{ promptBytes: 0 }, "promptBytes"],
	[{ promptBytes: 32_769 }, "promptBytes"],
	[{ promptBytes: 1.5 }, "promptBytes"],
	[{ toolResultBytes: 32_769 }, "toolResultBytes"],
	[{ toolResultBytes: -1 }, "toolResultBytes"],
	[{ requestBytes: 196_609 }, "requestBytes"],
	[{ requestBytes: Number.NaN }, "requestBytes"],
])("budgets %p are refused at startup, naming %s", (budgets, name) => {
	const root = mkdtempSync("/tmp/sb-budgets-");
	try {
		expect(() =>
			resolveSandboxRuntimeOptions(options(root, { budgets })),
		).toThrow(name);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("budgets at their maxima are accepted", () => {
	const root = mkdtempSync("/tmp/sb-budgets-");
	try {
		expect(
			resolveSandboxRuntimeOptions(
				options(root, {
					budgets: {
						promptBytes: 32_768,
						toolResultBytes: 32_768,
						requestBytes: 196_608,
					},
				}),
			).budgets?.requestBytes,
		).toBe(196_608);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a prompt over promptBytes stops startup naming both sizes, measured as the worker does", () => {
	const root = mkdtempSync("/tmp/sb-budgets-");
	try {
		// 3 bytes per character plus the two quotes JSON.stringify adds.
		const prompt = "\u5b57".repeat(1000);
		expect(() =>
			resolveSandboxRuntimeOptions(
				options(root, { prompt, budgets: { promptBytes: 2999 } }),
			),
		).toThrow(/3002 bytes.*2999/s);
		expect(
			resolveSandboxRuntimeOptions(
				options(root, { prompt, budgets: { promptBytes: 3002 } }),
			).prompt,
		).toBe(prompt);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("without budgets an oversized prompt starts as before; the worker still cuts it", () => {
	const root = mkdtempSync("/tmp/sb-budgets-");
	try {
		expect(
			resolveSandboxRuntimeOptions(
				options(root, { prompt: "x".repeat(20_000) }),
			).budgets,
		).toBeUndefined();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("the turn carries only the budgets the operator set, and none when unset", async () => {
	const root = mkdtempSync("/tmp/sb-budgets-");
	const seen: unknown[] = [];
	const driver = {
		run: async (_spec: unknown, turn: { budgets?: unknown }) => {
			seen.push(turn.budgets);
			return { ok: true, text: "done" };
		},
	};
	const plain = new SandboxRuntime(options(root, { driver }));
	const tuned = new SandboxRuntime(
		options(root, {
			driver,
			budgets: { toolResultBytes: 12_288, requestBytes: 98_304 },
		}),
	);
	try {
		await plain.runTurn("fake:a", speaker, "a");
		await tuned.runTurn("fake:b", speaker, "b");
		expect(seen).toEqual([
			undefined,
			{ toolResultBytes: 12_288, requestBytes: 98_304 },
		]);
	} finally {
		await plain.dispose();
		await tuned.dispose();
		rmSync(root, { recursive: true, force: true });
	}
});

test("host tools receive the result allowance net of the broker wrapper", async () => {
	const root = mkdtempSync("/tmp/sb-budgets-");
	const allowances: number[] = [];
	const tool = {
		name: "page",
		description: "Page",
		parameters: { type: "object" },
		run: (
			_input: Record<string, unknown>,
			context: { resultBytes: number },
		) => {
			allowances.push(context.resultBytes);
			return "x";
		},
	};
	const call = (budgets?: SandboxRuntimeOptions["budgets"]) =>
		new SandboxRuntime(
			options(root, {
				tools: [tool],
				budgets,
				driver: {
					run: async (spec) => {
						await unixBrokerRequest(
							"/tools/page",
							{},
							join(spec.runDir, "broker.sock"),
						);
						return { ok: true, text: "done" };
					},
				},
			}),
		);
	const defaults = call();
	const wide = call({ toolResultBytes: 12_288 });
	try {
		await defaults.runTurn("fake:a", speaker, "a");
		await wide.runTurn("fake:b", speaker, "b");
		// `{"text":"…"}` encoded twice costs 17 bytes around the text.
		expect(allowances).toEqual([4096 - 17, 12_288 - 17]);
	} finally {
		await defaults.dispose();
		await wide.dispose();
		rmSync(root, { recursive: true, force: true });
	}
});

test("maxCalls and maxOutputTokens set through the runtime reach the broker", async () => {
	const root = mkdtempSync("/tmp/sb-budgets-");
	const requested: unknown[] = [];
	const model = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: async (request) => {
			requested.push(
				((await request.json()) as { max_tokens: number }).max_tokens,
			);
			return Response.json({ choices: [] });
		},
	});
	const statuses: number[] = [];
	const runtime = new SandboxRuntime(
		options(root, {
			modelUrl: `http://127.0.0.1:${model.port}/v1/chat/completions`,
			maxCalls: 2,
			maxOutputTokens: 12_288,
			driver: {
				run: async (spec) => {
					for (let index = 0; index < 3; index++)
						statuses.push(
							(
								await unixBrokerRequest(
									"/model",
									{ messages: [{ role: "user", content: "hi" }] },
									join(spec.runDir, "broker.sock"),
								)
							).status,
						);
					return { ok: true, text: "done" };
				},
			},
		}),
	);
	try {
		await runtime.runTurn("fake:a", speaker, "a");
		expect(statuses).toEqual([200, 200, 429]);
		expect(requested).toEqual([12_288, 12_288]);
	} finally {
		await runtime.dispose();
		await model.stop(true);
		rmSync(root, { recursive: true, force: true });
	}
});

test("out-of-range maxCalls and maxOutputTokens stop startup", () => {
	const root = mkdtempSync("/tmp/sb-budgets-");
	try {
		expect(() =>
			resolveSandboxRuntimeOptions(options(root, { maxCalls: 1001 })),
		).toThrow();
		expect(() =>
			resolveSandboxRuntimeOptions(options(root, { maxOutputTokens: 40_000 })),
		).toThrow();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("requestBytes that cannot hold the prompt, notes, one message and eight tool results stops startup naming every size", () => {
	const root = mkdtempSync("/tmp/sb-budgets-");
	try {
		// 24,576 + 8,192 + 49,152 + 8 * 1,024 = 90,112 bytes needed.
		expect(() =>
			resolveSandboxRuntimeOptions(
				options(root, {
					budgets: { promptBytes: 24_576, requestBytes: 90_111 },
				}),
			),
		).toThrow(/90111.*24576.*8192.*49152.*8192/s);
		expect(
			resolveSandboxRuntimeOptions(
				options(root, {
					budgets: { promptBytes: 24_576, requestBytes: 90_112 },
				}),
			).budgets?.requestBytes,
		).toBe(90_112);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a request budget alone is checked against the default prompt budget", () => {
	const root = mkdtempSync("/tmp/sb-budgets-");
	try {
		expect(() =>
			resolveSandboxRuntimeOptions(
				options(root, { budgets: { requestBytes: 4096 } }),
			),
		).toThrow(/4096.*8192/s);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("heilun's budgets pass the request floor", () => {
	const root = mkdtempSync("/tmp/sb-budgets-");
	try {
		for (const toolResultBytes of [8192, 12_288])
			expect(
				resolveSandboxRuntimeOptions(
					options(root, {
						budgets: {
							promptBytes: 24_576,
							requestBytes: 98_304,
							toolResultBytes,
						},
					}),
				).budgets?.requestBytes,
			).toBe(98_304);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
