import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SandboxBroker } from "../src/broker.ts";
import type { SandboxTurn } from "../src/protocol.ts";
import { runWorkerTurn } from "./agent.ts";
import { SandboxMemory } from "./memory.ts";

// Regression: a full memory store and old oversized history must not lock out memory tools.
test("near-capacity memory and long Unicode history still fit the broker and allow removal", async () => {
	const workspace = mkdtempSync("/tmp/sb-prompt-");
	try {
		const memory = new SandboxMemory(workspace);
		for (let index = 0; index < 144; index++)
			memory.call(
				"memory_set",
				{
					scope: "channel",
					key: `note_${index}`,
					text: (index < 32 ? String.fromCodePoint(0x4e01) : "a").repeat(2048),
				},
				"alice",
			);
		writeFileSync(
			join(workspace, "history.json"),
			JSON.stringify(
				Array.from({ length: 20 }, (_, index) => ({
					role: index % 2 ? "assistant" : "user",
					content: "h".repeat(100_000),
				})),
			),
		);
		let calls = 0;
		const broker = new SandboxBroker({
			context: {
				channel: "fake:guests",
				speaker: { id: "alice", name: "Alice" },
				signal: new AbortController().signal,
			},
			model: "fake",
			modelUrl: "https://models.example/chat",
			apiKey: () => "host-only-key",
			fetchImpl: async (_url, init) => {
				calls++;
				expect(Buffer.byteLength(String(init.body))).toBeLessThan(192 * 1024);
				return Response.json({
					choices: [
						{
							message:
								calls === 1
									? {
											content: "",
											tool_calls: [
												{
													id: "remove",
													type: "function",
													function: {
														name: "memory_remove",
														arguments: '{"scope":"channel","key":"note_0"}',
													},
												},
											],
										}
									: { content: "Removed." },
						},
					],
				});
			},
		});
		const reply = await runWorkerTurn(
			{ ...turn, text: String.fromCodePoint(0x4e01).repeat(20_000) },
			{
				workspace,
				broker: async (route, body) => {
					const response = await broker.handle(
						new Request(`http://broker${route}`, {
							method: "POST",
							body: JSON.stringify(body),
						}),
					);
					expect(response.status).toBe(200);
					return response.json();
				},
			},
		);
		expect(reply).toEqual({ ok: true, text: "Removed." });
		expect(calls).toBe(2);
		expect(
			new SandboxMemory(workspace).call(
				"memory_get",
				{ scope: "channel", key: "note_0" },
				"alice",
			),
		).toBe("[]");
	} finally {
		rmSync(workspace, { recursive: true, force: true });
	}
});

const turn: SandboxTurn = {
	text: "Remember tea",
	speaker: { id: "alice", name: "Alice" },
	model: "fake",
	prompt: "Be helpful",
	timeZone: "UTC",
	tools: [],
	mcp: [],
};

test("worker tool loop saves current-speaker memory, refuses unknown tools, and continues channel history", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "sandbox-worker-"));
	let calls = 0;
	try {
		const result = await runWorkerTurn(turn, {
			workspace,
			broker: async (route, body) => {
				expect(route).toBe("/model");
				calls++;
				if (calls === 1)
					return {
						choices: [
							{
								message: {
									role: "assistant",
									content: null,
									tool_calls: [
										{
											id: "one",
											type: "function",
											function: {
												name: "memory_set",
												arguments: JSON.stringify({
													scope: "speaker",
													key: "drink",
													text: "Tea",
													speaker: "owner",
												}),
											},
										},
										{
											id: "two",
											type: "function",
											function: { name: "bash", arguments: "{}" },
										},
									],
								},
							},
						],
					};
				expect(JSON.stringify(body.messages)).toContain(
					"Tool call refused or failed.",
				);
				return { choices: [{ message: { content: "Remembered." } }] };
			},
		});
		expect(result).toEqual({ ok: true, text: "Remembered." });
		await runWorkerTurn(
			{ ...turn, text: "What do I drink?" },
			{
				workspace,
				broker: async (_route, body) => {
					expect(JSON.stringify(body.messages)).toContain("Tea");
					expect(JSON.stringify(body.messages)).toContain("Remembered.");
					return { choices: [{ message: { content: "Tea." } }] };
				},
			},
		);
		await runWorkerTurn(
			{ ...turn, reset: true, speaker: { id: "bob", name: "Bob" } },
			{
				workspace,
				broker: async (_route, body) => {
					expect(JSON.stringify(body.messages)).not.toContain("Tea");
					expect(JSON.stringify(body.messages)).not.toContain("Remembered.");
					return { choices: [{ message: { content: "Hello." } }] };
				},
			},
		);
	} finally {
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("worker reaches host and MCP only through declared broker routes", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "sandbox-worker-"));
	const routes: string[] = [];
	let modelCalls = 0;
	try {
		const result = await runWorkerTurn(
			{
				...turn,
				tools: [
					{
						name: "clock",
						description: "Clock",
						parameters: { type: "object" },
					},
				],
				mcp: [
					{
						server: "catalog",
						tools: [
							{
								name: "search",
								description: "Search",
								parameters: { type: "object" },
							},
						],
					},
				],
			},
			{
				workspace,
				broker: async (route, body) => {
					routes.push(route);
					if (route !== "/model") return { text: "found" };
					modelCalls++;
					if (modelCalls === 1) {
						expect(JSON.stringify(body.tools)).toContain("host_clock");
						return {
							choices: [
								{
									message: {
										tool_calls: [
											{
												id: "c",
												function: { name: "host_clock", arguments: "{}" },
											},
											{
												id: "s",
												function: {
													name: "mcp_0_search",
													arguments: '{"query":"a"}',
												},
											},
										],
									},
								},
							],
						};
					}
					return { choices: [{ message: { content: "Done." } }] };
				},
			},
		);
		expect(result.ok).toBe(true);
		expect(routes).toEqual([
			"/model",
			"/tools/clock",
			"/mcp/catalog",
			"/model",
		]);
	} finally {
		rmSync(workspace, { recursive: true, force: true });
	}
});
