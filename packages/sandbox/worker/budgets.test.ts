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
