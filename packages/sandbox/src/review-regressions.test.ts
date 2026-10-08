import { expect, test } from "bun:test";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { runWorkerTurn } from "../worker/agent.ts";
import { unixBrokerRequest } from "../worker/transport.ts";
import { SandboxBroker } from "./broker.ts";
import { SandboxChannelStore } from "./channel-store.ts";
import { DockerContainerDriver } from "./container-driver.ts";
import { modelInput } from "./model-input.ts";
import { isRecord, type SandboxTurn } from "./protocol.ts";
import { SandboxRuntime } from "./runtime.ts";

const admitted = { id: "guest", name: "Guest", principalId: "p_guest" };
const turn: SandboxTurn = {
	text: "Hello",
	speaker: { id: "guest", name: "Guest" },
	model: "fake",
	prompt: "Be useful",
	timeZone: "UTC",
	tools: [],
	mcp: [],
};

test("routing failures preserve mode and malformed saved state is refused", () => {
	const root = mkdtempSync("/tmp/sb-state-");
	const file = join(root, "channels.json");
	try {
		const store = new SandboxChannelStore(file, ["fake:a"]);
		mkdirSync(`${file}.tmp`);
		expect(() => store.enable("fake:b")).toThrow();
		expect(store.list()).toEqual(["fake:a"]);
		expect(() => store.disable("fake:a")).toThrow();
		expect(store.list()).toEqual(["fake:a"]);
		writeFileSync(file, '{"invalid":"state"}');
		expect(() => new SandboxChannelStore(file)).toThrow();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("existing non-private state and runtime roots fail closed", () => {
	const root = mkdtempSync("/tmp/sb-permissions-");
	try {
		chmodSync(root, 0o755);
		expect(
			() => new SandboxChannelStore(join(root, "channels.json")),
		).toThrow();
		expect(
			() =>
				new SandboxRuntime({
					image: "sandbox:fake",
					runRoot: root,
					workspaceRoot: join(root, "work"),
					model: "fake",
					modelUrl: "https://models.example/chat",
					apiKey: () => "fake-host-key",
					driver: { run: async () => ({ ok: true, text: "done" }) },
				}),
		).toThrow();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("Unix transport preserves a plain-text budget refusal status without forwarding error details", async () => {
	const root = mkdtempSync("/tmp/sb-status-");
	const socketPath = join(root, "broker.sock");
	const listener = await new SandboxBroker({
		context: {
			channel: "fake:a",
			speaker: admitted,
			signal: new AbortController().signal,
		},
		model: "fake",
		modelUrl: "https://models.example/chat",
		apiKey: () => "fake-host-key",
		maxCalls: 1,
		fetchImpl: async () => Response.json({ choices: [] }),
	}).listen(socketPath);
	try {
		expect(
			(await unixBrokerRequest("/model", { messages: [] }, socketPath)).status,
		).toBe(200);
		expect(
			await unixBrokerRequest("/model", { messages: [] }, socketPath),
		).toEqual({ status: 429, body: { error: "broker refused" } });
	} finally {
		await listener.stop(true);
		rmSync(root, { recursive: true, force: true });
	}
});

for (const keyword of [
	"$ref",
	"$dynamicRef",
	"$recursiveRef",
	"$schema",
	"$id",
	"$vocabulary",
]) {
	test(`refuses remote schema keyword ${keyword} at schema positions`, () => {
		const parameters = {
			type: "object",
			properties: {
				example: {
					[keyword]:
						keyword === "$vocabulary"
							? { "https://guest.example/schema": true }
							: "https://guest.example/schema",
				},
			},
		};
		expect(
			modelInput({
				messages: [],
				tools: [
					{
						type: "function",
						function: { name: "example", description: "Example", parameters },
					},
				],
			}),
		).toBeUndefined();
	});
}

test("schema property names and enum data are not interpreted as reference keywords", () => {
	const parameters = {
		type: "object",
		properties: { $ref: { type: "string" }, $schema: { type: "string" } },
		enum: [{ $ref: "https://guest.example/literal-value" }],
		$defs: { item: { type: "string" } },
		allOf: [{ $ref: "#/$defs/item" }],
	};
	expect(
		modelInput({
			messages: [],
			tools: [
				{
					type: "function",
					function: { name: "example", description: "Example", parameters },
				},
			],
		}),
	).toBeDefined();
});

for (const variant of ["invalid-name", "long-id", "duplicate-id"]) {
	test(`worker repairs provider tool calls before replaying through the real broker: ${variant}`, async () => {
		const root = mkdtempSync("/tmp/sb-call-");
		let calls = 0;
		const statuses: number[] = [];
		try {
			const broker = new SandboxBroker({
				context: {
					channel: "fake:guests",
					speaker: admitted,
					signal: new AbortController().signal,
				},
				model: "fake",
				modelUrl: "https://models.example/chat",
				apiKey: () => "fake-host-key",
				fetchImpl: async (_url, init) => {
					calls++;
					if (calls === 1) {
						const call = {
							id: variant === "long-id" ? "i".repeat(200) : "call_0_1",
							type: "function",
							function: {
								name: variant === "invalid-name" ? "Memory-Get" : "memory_get",
								arguments: '{"scope":"channel"}',
							},
						};
						return Response.json({
							choices: [
								{
									message: {
										content: "",
										tool_calls:
											variant === "duplicate-id" ? [call, call] : [call],
									},
								},
							],
						});
					}
					const body: unknown = JSON.parse(String(init.body));
					if (!isRecord(body) || !Array.isArray(body.messages))
						throw new Error("invalid fixture request");
					const assistant = body.messages.find(
						(message: unknown) =>
							isRecord(message) && message.role === "assistant",
					);
					if (!isRecord(assistant) || !Array.isArray(assistant.tool_calls))
						throw new Error("missing replayed calls");
					const ids = assistant.tool_calls.map((call: unknown) =>
						isRecord(call) ? call.id : undefined,
					);
					const replies = body.messages.filter(
						(message: unknown) => isRecord(message) && message.role === "tool",
					);
					expect(new Set(ids).size).toBe(ids.length);
					expect(
						replies.map((reply: unknown) =>
							isRecord(reply) ? reply.tool_call_id : undefined,
						),
					).toEqual(ids);
					if (variant === "invalid-name")
						expect(JSON.stringify(assistant)).toContain("invalid_tool");
					return Response.json({
						choices: [{ message: { content: "Recovered." } }],
					});
				},
			});
			expect(
				await runWorkerTurn(turn, {
					workspace: root,
					broker: async (route, body) => {
						const response = await broker.handle(
							new Request(`http://broker${route}`, {
								method: "POST",
								body: JSON.stringify(body),
							}),
						);
						statuses.push(response.status);
						expect(response.status).toBe(200);
						return response.json();
					},
				}),
			).toEqual({ ok: true, text: "Recovered." });
			expect(statuses).toEqual([200, 200]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
}

test("normal turn completion aborts a host call when its worker exits without waiting", async () => {
	const root = mkdtempSync("/tmp/sb-cancel-");
	let started: (() => void) | undefined;
	const ready = new Promise<void>((resolve) => {
		started = resolve;
	});
	let pending: Promise<unknown> | undefined;
	let aborted = false;
	const runtime = new SandboxRuntime({
		image: "sandbox:fake",
		runRoot: join(root, "run"),
		workspaceRoot: join(root, "work"),
		model: "fake",
		modelUrl: "https://models.example/chat",
		apiKey: () => "fake-host-key",
		tools: [
			{
				name: "wait",
				description: "Wait",
				parameters: { type: "object" },
				run: (_input, context) =>
					new Promise<string>((resolve) => {
						context.signal.addEventListener(
							"abort",
							() => {
								aborted = context.signal.aborted;
								resolve("Cancelled.");
							},
							{ once: true },
						);
						started?.();
					}),
			},
		],
		driver: {
			run: async (spec) => {
				pending = unixBrokerRequest(
					"/tools/wait",
					{},
					join(spec.runDir, "broker.sock"),
				).catch(() => undefined);
				await ready;
				return { ok: true, text: "Done." };
			},
		},
	});
	try {
		expect(await runtime.runTurn("fake:guests", admitted, "Hello")).toEqual({
			ok: true,
			text: "Done.",
		});
		await pending;
		expect(aborted).toBe(true);
	} finally {
		await runtime.dispose();
		rmSync(root, { recursive: true, force: true });
	}
});

test("driver retries automatic-removal conflict and accepts confirmed absence", async () => {
	const root = mkdtempSync("/tmp/sb-conflict-");
	const count = join(root, "count");
	const binary = join(root, "fake-docker");
	writeFileSync(
		binary,
		`#!/usr/bin/env bun\nimport{existsSync,readFileSync,writeFileSync}from"node:fs";if(process.argv[2]==="run"){await Bun.stdin.text();process.stdout.write('{"ok":true,"text":"Done."}');}else{const n=existsSync(${JSON.stringify(count)})?Number(readFileSync(${JSON.stringify(count)},"utf8")):0;writeFileSync(${JSON.stringify(count)},String(n+1));process.stderr.write(n===0?"removal of container is already in progress":"No such container");process.exit(1);}\n`,
	);
	chmodSync(binary, 0o700);
	mkdirSync(join(root, "run"));
	mkdirSync(join(root, "work"));
	try {
		expect(
			await new DockerContainerDriver(binary).run(
				{
					name: "sandbox-conflict",
					image: "sandbox:fake",
					runDir: join(root, "run"),
					workspaceDir: join(root, "work"),
					uid: 1000,
					gid: 1000,
				},
				turn,
				new AbortController().signal,
			),
		).toEqual({ ok: true, text: "Done." });
		expect(readFileSync(count, "utf8")).toBe("2");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
