import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxTurn } from "../src/protocol.ts";
import { isSandboxTurn } from "../src/protocol.ts";
import { runWorkerTurn } from "./agent.ts";

const turn: SandboxTurn = {
	text: "go",
	speaker: { id: "alice", name: "Alice" },
	model: "fake",
	prompt: "Be helpful",
	timeZone: "UTC",
	tools: [],
	mcp: [],
};

function systemOf(body: Record<string, unknown>): string {
	return String((body.messages as { content: string }[])[0]?.content);
}

test.each([
	[undefined, 8192],
	[{ promptBytes: 20_000 }, 20_000],
	[{ promptBytes: 2000 }, 2000],
])(
	"promptBytes %p bounds the system prompt (cut at %d bytes)",
	async (budgets, limit) => {
		const workspace = mkdtempSync(join(tmpdir(), "sb-budget-"));
		try {
			const prompt = "p".repeat(40_000);
			let system = "";
			await runWorkerTurn(
				{ ...turn, prompt, ...(budgets ? { budgets } : {}) },
				{
					workspace,
					broker: async (_route, body) => {
						system = systemOf(body);
						return { choices: [{ message: { content: "ok" } }] };
					},
				},
			);
			const promptPart = system.slice(0, system.indexOf("\nCurrent time:"));
			expect(Buffer.byteLength(JSON.stringify(promptPart))).toBeLessThanOrEqual(
				limit,
			);
			expect(Buffer.byteLength(JSON.stringify(promptPart))).toBeGreaterThan(
				limit - 200,
			);
		} finally {
			rmSync(workspace, { recursive: true, force: true });
		}
	},
);

async function toolResult(
	budgets: SandboxTurn["budgets"],
	text: string,
): Promise<string> {
	const workspace = mkdtempSync(join(tmpdir(), "sb-budget-"));
	let seen = "";
	let calls = 0;
	try {
		await runWorkerTurn(
			{
				...turn,
				...(budgets ? { budgets } : {}),
				tools: [
					{ name: "page", description: "Page", parameters: { type: "object" } },
				],
			},
			{
				workspace,
				broker: async (route, body) => {
					if (route === "/tools/page") return { text };
					calls++;
					if (calls === 1)
						return {
							choices: [
								{
									message: {
										tool_calls: [
											{
												id: "t",
												function: { name: "host_page", arguments: "{}" },
											},
										],
									},
								},
							],
						};
					const messages = body.messages as { role: string; content: string }[];
					seen =
						messages.filter((message) => message.role === "tool")[0]?.content ??
						"";
					return { choices: [{ message: { content: "ok" } }] };
				},
			},
		);
		return seen;
	} finally {
		rmSync(workspace, { recursive: true, force: true });
	}
}

test("a tool result up to toolResultBytes passes whole; over it is cut with a note that does not point at memory_get", async () => {
	const body = "w".repeat(10_000);
	const defaults = await toolResult(undefined, body);
	expect(Buffer.byteLength(JSON.stringify(defaults))).toBeLessThanOrEqual(4096);
	expect(defaults).toContain("cut");
	expect(defaults).not.toContain("memory_get");

	const wide = await toolResult({ toolResultBytes: 12_288 }, body);
	// The whole `{"text":…}` result fits once the budget allows it.
	expect(wide).toBe(JSON.stringify({ text: body }));

	const huge = await toolResult(
		{ toolResultBytes: 12_288 },
		"w".repeat(20_000),
	);
	expect(Buffer.byteLength(JSON.stringify(huge))).toBeLessThanOrEqual(12_288);
	expect(huge).toContain("cut");
});

test("a result sized to resultBytes (budget minus wrapper) fits exactly, escapes included", async () => {
	const budget = 4096;
	const wrapper = 17;
	// Newlines are escaped twice: 4 bytes each in the worker's measure.
	const fits = "\n".repeat(Math.floor((budget - wrapper) / 4));
	const seen = await toolResult({ toolResultBytes: budget }, fits);
	expect(seen).toBe(JSON.stringify({ text: fits }));
});

test("requestBytes bounds each model request, dropping the oldest history first", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "sb-budget-"));
	try {
		writeFileSync(
			join(workspace, "history.json"),
			JSON.stringify(
				Array.from({ length: 20 }, (_, index) => ({
					role: index % 2 ? "assistant" : "user",
					content: `${index}:${"h".repeat(8000)}`,
				})),
			),
		);
		const sizes: number[] = [];
		let kept = "";
		await runWorkerTurn(
			{ ...turn, budgets: { requestBytes: 40_000 } },
			{
				workspace,
				broker: async (_route, body) => {
					sizes.push(Buffer.byteLength(JSON.stringify(body)));
					kept = JSON.stringify(body.messages);
					return { choices: [{ message: { content: "ok" } }] };
				},
			},
		);
		expect(sizes[0]).toBeLessThanOrEqual(40_000);
		expect(kept).toContain("19:");
		expect(kept).not.toContain('"0:h');
	} finally {
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("without budgets the request limit stays 192 KiB", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "sb-budget-"));
	try {
		writeFileSync(
			join(workspace, "history.json"),
			JSON.stringify(
				Array.from({ length: 20 }, (_, index) => ({
					role: index % 2 ? "assistant" : "user",
					content: "h".repeat(8000),
				})),
			),
		);
		const sizes: number[] = [];
		await runWorkerTurn(turn, {
			workspace,
			broker: async (_route, body) => {
				sizes.push(Buffer.byteLength(JSON.stringify(body)));
				return { choices: [{ message: { content: "ok" } }] };
			},
		});
		expect(sizes[0]).toBeGreaterThan(150_000);
		expect(sizes[0]).toBeLessThanOrEqual(192 * 1024);
	} finally {
		rmSync(workspace, { recursive: true, force: true });
	}
});

test.each([
	[{ promptBytes: 32_769 }, false],
	[{ toolResultBytes: 0 }, false],
	[{ requestBytes: 196_609 }, false],
	[{ requestBytes: "big" }, false],
	[{ extra: 1 }, false],
	[
		{ promptBytes: 32_768, toolResultBytes: 32_768, requestBytes: 196_608 },
		true,
	],
	[{}, true],
])(
	"the worker reads budgets %p from the turn (valid: %p)",
	(budgets, valid) => {
		expect(isSandboxTurn({ ...turn, budgets })).toBe(valid);
	},
);

const eightCalls = Array.from({ length: 8 }, (_, index) => ({
	id: `t${index}`,
	function: { name: "host_page", arguments: "{}" },
}));

async function eightToolTurn(
	budgets: NonNullable<SandboxTurn["budgets"]>,
	text: string,
	prompt = "Be helpful",
): Promise<{
	reply: { ok: boolean; text: string };
	modelCalls: number;
	lastTools: { tool_call_id: string; content: string }[];
	lastSize: number;
}> {
	const workspace = mkdtempSync(join(tmpdir(), "sb-budget-"));
	let modelCalls = 0;
	let lastTools: { tool_call_id: string; content: string }[] = [];
	let lastSize = 0;
	try {
		const reply = await runWorkerTurn(
			{
				...turn,
				prompt,
				budgets,
				tools: [
					{ name: "page", description: "Page", parameters: { type: "object" } },
				],
			},
			{
				workspace,
				broker: async (route, body) => {
					if (route === "/tools/page") return { text };
					modelCalls++;
					const messages = body.messages as {
						role: string;
						tool_call_id: string;
						content: string;
					}[];
					lastTools = messages.filter((message) => message.role === "tool");
					lastSize = Buffer.byteLength(JSON.stringify(body));
					if (lastTools.length === 0)
						return { choices: [{ message: { tool_calls: eightCalls } }] };
					return { choices: [{ message: { content: "done" } }] };
				},
			},
		);
		return { reply, modelCalls, lastTools, lastSize };
	} finally {
		rmSync(workspace, { recursive: true, force: true });
	}
}

test("a request that cannot hold eight whole tool results keeps the newest group with every result cut to its share", async () => {
	const { reply, modelCalls, lastTools, lastSize } = await eightToolTurn(
		{ promptBytes: 4096, toolResultBytes: 12_288, requestBytes: 40_000 },
		"w".repeat(20_000),
	);
	expect(reply).toEqual({ ok: true, text: "done" });
	expect(modelCalls).toBe(2);
	expect(lastTools.map((tool) => tool.tool_call_id)).toEqual(
		eightCalls.map((call) => call.id),
	);
	for (const tool of lastTools) expect(tool.content).toContain("cut");
	expect(lastSize).toBeLessThanOrEqual(40_000);
});

test("a small result stays whole while the large ones share what is left", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "sb-budget-"));
	try {
		let calls = 0;
		let seen: { tool_call_id: string; content: string }[] = [];
		const texts = ["tiny", ...Array(7).fill("w".repeat(12_000))];
		let next = 0;
		const reply = await runWorkerTurn(
			{
				...turn,
				budgets: {
					promptBytes: 4096,
					toolResultBytes: 12_288,
					requestBytes: 30_000,
				},
				tools: [
					{ name: "page", description: "Page", parameters: { type: "object" } },
				],
			},
			{
				workspace,
				broker: async (route, body) => {
					if (route === "/tools/page") return { text: texts[next++] };
					calls++;
					const messages = body.messages as {
						role: string;
						tool_call_id: string;
						content: string;
					}[];
					seen = messages.filter((message) => message.role === "tool");
					if (seen.length === 0)
						return { choices: [{ message: { tool_calls: eightCalls } }] };
					return { choices: [{ message: { content: "done" } }] };
				},
			},
		);
		expect(reply.ok).toBe(true);
		expect(calls).toBe(2);
		expect(seen[0]?.content).toBe(JSON.stringify({ text: "tiny" }));
		expect(seen[1]?.content).toContain("cut");
	} finally {
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("heilun's budgets (24576 / 98304 / 12288) answer after eight full-size tool results", async () => {
	const { reply, modelCalls, lastTools, lastSize } = await eightToolTurn(
		{ promptBytes: 24_576, toolResultBytes: 12_288, requestBytes: 98_304 },
		"w".repeat(20_000),
		"p".repeat(30_000),
	);
	expect(reply).toEqual({ ok: true, text: "done" });
	expect(modelCalls).toBe(2);
	expect(lastTools).toHaveLength(8);
	expect(lastSize).toBeLessThanOrEqual(98_304);
	const kept = lastTools.map((tool) => Buffer.byteLength(tool.content));
	for (const size of kept) expect(size).toBeGreaterThan(2048);
});
