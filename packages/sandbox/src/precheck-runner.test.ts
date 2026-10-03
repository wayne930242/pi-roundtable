import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { PrecheckScriptContext, Schedule } from "pi-roundtable";
import { listenBroker } from "./broker.ts";
import { type ContainerSpec, containerRunArgs } from "./container-driver.ts";
import {
	PRECHECK_ENTRYPOINT,
	type PrecheckMcpServer,
	type PrecheckWorkerInput,
	precheckBroker,
	precheckScriptRunner,
} from "./precheck-runner.ts";
import { DUMMY_KEY } from "./protocol.ts";

const WORKER = resolve(import.meta.dir, "../worker/precheck-main.ts");
const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});
function root(): string {
	const dir = mkdtempSync(join(tmpdir(), "pc-"));
	roots.push(dir);
	return dir;
}

const HEALTH: PrecheckMcpServer = {
	name: "health",
	url: "https://mcp.example.test/servers/health/mcp",
	tools: ["garmin-login", "garmin-get-hrv"],
	token: () => "host-secret-token",
};

/** A fake MCP upstream that answers each granted tool and records what reached it. */
function upstream(answers: Record<string, unknown>, eventStream = false) {
	const seen: { auth: string | null; body: Record<string, unknown> }[] = [];
	const fetchImpl = async (_url: string, init: RequestInit) => {
		const body = JSON.parse(String(init.body)) as {
			params: { name: string };
		};
		seen.push({
			auth: new Headers(init.headers).get("authorization"),
			body: body as unknown as Record<string, unknown>,
		});
		const message = {
			jsonrpc: "2.0",
			id: 1,
			result: {
				content: [
					{ type: "text", text: JSON.stringify(answers[body.params.name]) },
				],
			},
		};
		return eventStream
			? new Response(`event: message\ndata: ${JSON.stringify(message)}\n\n`, {
					headers: { "content-type": "text/event-stream" },
				})
			: Response.json(message);
	};
	return { seen, fetchImpl };
}

const call = (
	handle: (request: Request) => Promise<Response>,
	path: string,
	body: unknown,
	headers: Record<string, string> = {},
) =>
	handle(
		new Request(`http://broker${path}`, {
			method: "POST",
			headers: { "content-type": "application/json", ...headers },
			body: JSON.stringify(body),
		}),
	);

const toolCall = (name: string) => ({
	jsonrpc: "2.0",
	id: 1,
	method: "tools/call",
	params: { name, arguments: {} },
});

describe("the precheck broker", () => {
	test("forwards a granted tools/call with the host's credential, as JSON or one SSE event", async () => {
		for (const eventStream of [false, true]) {
			const { seen, fetchImpl } = upstream(
				{ "garmin-get-hrv": { avg: 27 } },
				eventStream,
			);
			const handle = precheckBroker({
				servers: [HEALTH],
				signal: new AbortController().signal,
				maxCalls: 4,
				fetchImpl,
			});
			const response = await call(
				handle,
				"/mcp/health",
				toolCall("garmin-get-hrv"),
				{
					authorization: `Bearer ${DUMMY_KEY}`,
				},
			);
			expect(response.status).toBe(200);
			const message = (await response.json()) as {
				result: { content: { text: string }[] };
			};
			expect(JSON.parse(message.result.content[0]?.text ?? "")).toEqual({
				avg: 27,
			});
			expect(seen.map((s) => s.auth)).toEqual(["Bearer host-secret-token"]);
		}
	});

	test("refuses other servers, tools, methods, queries, credentials, and calls past the budget", async () => {
		const { seen, fetchImpl } = upstream({ "garmin-login": {} });
		const handle = precheckBroker({
			servers: [HEALTH],
			signal: new AbortController().signal,
			// Refused calls count too, so a script cannot probe without limit.
			maxCalls: 3,
			fetchImpl,
		});
		expect(
			(await call(handle, "/mcp/other", toolCall("garmin-login"))).status,
		).toBe(404);
		expect(
			(await call(handle, "/mcp/health?x=1", toolCall("garmin-login"))).status,
		).toBe(404);
		expect(
			(
				await call(handle, "/mcp/health", toolCall("garmin-login"), {
					authorization: "Bearer stolen",
				})
			).status,
		).toBe(404);
		expect((await call(handle, "/model", { messages: [] })).status).toBe(404);
		expect(
			(await call(handle, "/mcp/health", toolCall("garmin-delete-everything")))
				.status,
		).toBe(403);
		expect(
			(
				await call(handle, "/mcp/health", {
					jsonrpc: "2.0",
					id: 1,
					method: "tools/list",
				})
			).status,
		).toBe(403);
		expect(
			(await call(handle, "/mcp/health", toolCall("garmin-login"))).status,
		).toBe(200);
		expect(
			(await call(handle, "/mcp/health", toolCall("garmin-login"))).status,
		).toBe(429);
		expect(seen).toHaveLength(1);
	});

	test("refuses an answer that reflects the credential", async () => {
		const handle = precheckBroker({
			servers: [HEALTH],
			signal: new AbortController().signal,
			maxCalls: 2,
			fetchImpl: async () =>
				Response.json({
					jsonrpc: "2.0",
					id: 1,
					result: { echo: "host-secret-token" },
				}),
		});
		expect(
			(await call(handle, "/mcp/health", toolCall("garmin-login"))).status,
		).toBe(502);
	});
});

describe("the precheck broker, against a hostile upstream", () => {
	const reflected = (result: unknown, eventStream: boolean) =>
		precheckBroker({
			servers: [HEALTH],
			signal: new AbortController().signal,
			maxCalls: 2,
			fetchImpl: async () => {
				// Escaped as JSON may escape it, so the raw text never holds it plainly.
				const message = JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					result,
				}).replaceAll("host-secret-token", "\\u0068ost-secret-token");
				return eventStream
					? new Response(`data: ${message}\n\n`, {
							headers: { "content-type": "text/event-stream" },
						})
					: new Response(message);
			},
		});

	test("refuses the credential escaped, inside JSON text, base64-encoded, or as a key", async () => {
		for (const result of [
			{ echo: "host-secret-token" },
			{
				content: [
					{
						type: "text",
						text: JSON.stringify({ token: "host-secret-token" }),
					},
				],
			},
			{ echo: Buffer.from("host-secret-token").toString("base64") },
			{ "host-secret-token": 1 },
		])
			for (const eventStream of [false, true])
				expect(
					(
						await call(
							reflected(result, eventStream),
							"/mcp/health",
							toolCall("garmin-login"),
						)
					).status,
				).toBe(502);
	});

	test("joins an SSE event's data lines", async () => {
		const handle = precheckBroker({
			servers: [HEALTH],
			signal: new AbortController().signal,
			maxCalls: 2,
			fetchImpl: async () =>
				new Response(
					'event: message\ndata: {"jsonrpc": "2.0",\ndata:  "id": 1, "result": {"ok": true}}\n\n',
					{ headers: { "content-type": "text/event-stream" } },
				),
		});
		const response = await call(
			handle,
			"/mcp/health",
			toolCall("garmin-login"),
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			jsonrpc: "2.0",
			id: 1,
			result: { ok: true },
		});
	});

	test("refuses a second call while one is pending, without spending the budget", async () => {
		let release = () => {};
		const handle = precheckBroker({
			servers: [HEALTH],
			signal: new AbortController().signal,
			maxCalls: 2,
			fetchImpl: () =>
				new Promise<Response>((resolve) => {
					release = () =>
						resolve(Response.json({ jsonrpc: "2.0", id: 1, result: {} }));
				}),
		});
		const first = call(handle, "/mcp/health", toolCall("garmin-login"));
		await Bun.sleep(5);
		expect(
			(await call(handle, "/mcp/health", toolCall("garmin-login"))).status,
		).toBe(409);
		release();
		expect((await first).status).toBe(200);
		// The refused call spent nothing, so the budget of two still has one left.
		const third = call(handle, "/mcp/health", toolCall("garmin-login"));
		await Bun.sleep(5);
		release();
		expect((await third).status).toBe(200);
	});
});

describe("the container a script runs in", () => {
	test("is sealed as a guest's is, and runs the precheck worker instead of the image's command", () => {
		const spec: ContainerSpec = {
			name: "roundtable-precheck-13-abcd1234",
			image: "sandbox:pi",
			runDir: "/run/pc/precheck-x",
			workspaceDir: "/run/pc/precheck-ws-x",
			uid: 1000,
			gid: 1000,
			memoryMb: 256,
			pids: 32,
			entrypoint: PRECHECK_ENTRYPOINT,
		};
		const args = containerRunArgs(spec);
		for (const flag of [
			["--network", "none"],
			["--read-only"],
			["--cap-drop", "ALL"],
			["--security-opt", "no-new-privileges:true"],
			["--user", "1000:1000"],
			["--entrypoint", "bun"],
		])
			expect(args.join("\n")).toContain(flag.join("\n"));
		expect(args.join("\n")).not.toContain("dst=/workspace,readonly");
		expect(
			containerRunArgs({ ...spec, workspaceReadOnly: true }).join("\n"),
		).toContain("dst=/workspace,readonly,bind-propagation=rprivate");
		expect(args.slice(-2)).toEqual([
			"sandbox:pi",
			"/app/node_modules/pi-roundtable-sandbox/worker/precheck-main.ts",
		]);
		expect(() =>
			containerRunArgs({ ...spec, entrypoint: ["bun", "--inspect=0.0.0.0"] }),
		).toThrow("invalid entrypoint");
	});
});

const schedule: Schedule = {
	id: 13,
	title: "recovery",
	channel: "discord:owner",
	target: "owner",
	prompt: "check last night's recovery",
	recurrence: {
		kind: "every",
		time: "09:30",
		everyDays: 1,
		startDate: "2026-10-01",
	},
	nextRun: new Date("2026-10-05T01:30:00Z"),
	createdById: "owner",
	createdByName: "Owner",
	createdTier: "owner",
	createdAt: new Date("2026-10-01T00:00:00Z"),
};

function scriptContext(
	tools: PrecheckScriptContext["tools"] = HEALTH.tools.map((tool) => ({
		server: "health",
		tool,
	})),
): PrecheckScriptContext {
	return {
		schedule,
		firedAt: new Date("2026-10-04T01:30:00Z"),
		timeZone: "Asia/Taipei",
		today: "2026-10-04",
		tools,
		signal: new AbortController().signal,
	};
}

describe("the precheck script runner", () => {
	test("hands the worker, and lets the broker forward, only the tools approved with the script", async () => {
		const inputs: PrecheckWorkerInput[] = [];
		const runner = precheckScriptRunner({
			image: "sandbox:pi",
			runRoot: root(),
			uid: 1000,
			gid: 1000,
			grant: () => [
				HEALTH,
				{ ...HEALTH, name: "google", tools: ["send-gmail-message"] },
			],
			driver: {
				exec: async (spec, input) => {
					inputs.push(JSON.parse(input));
					// The broker of this run refuses a granted tool that was not approved.
					const refused = await fetch("http://broker/mcp/health", {
						unix: join(spec.runDir, "broker.sock"),
						method: "POST",
						body: JSON.stringify(toolCall("garmin-login")),
					});
					expect(refused.status).toBe(403);
					const unknown = await fetch("http://broker/mcp/google", {
						unix: join(spec.runDir, "broker.sock"),
						method: "POST",
						body: JSON.stringify(toolCall("send-gmail-message")),
					});
					expect(unknown.status).toBe(404);
					return JSON.stringify({ ok: true, result: { wake: false } });
				},
			},
		});
		await runner.run(
			"export default () => ({ wake: false })",
			scriptContext([
				{ server: "health", tool: "garmin-get-hrv" },
				// Approved but no longer granted: still refused.
				{ server: "other", tool: "x" },
			]),
		);
		expect(inputs[0]?.servers).toEqual([
			{ name: "health", tools: ["garmin-get-hrv"] },
		]);
		expect(runner.toolName("google", "send-gmail-message")).toBe(
			"send-gmail-message",
		);
		expect(
			precheckScriptRunner({
				image: "sandbox:pi",
				runRoot: root(),
				uid: 1000,
				gid: 1000,
				grant: () => [],
				toolName: (server, tool) => `${server}-${tool}`,
			}).toolName("google", "send-gmail-message"),
		).toBe("google-send-gmail-message");
	});

	test("hands the worker the script, the date, and the granted names only, and returns its answer", async () => {
		const runRoot = root();
		const runs: { spec: ContainerSpec; input: PrecheckWorkerInput }[] = [];
		const scopes: unknown[] = [];
		const runner = precheckScriptRunner({
			image: "sandbox:pi",
			runRoot,
			uid: 1000,
			gid: 1000,
			grant: (scope) => {
				scopes.push(scope);
				return [HEALTH];
			},
			driver: {
				exec: async (spec, input) => {
					runs.push({ spec, input: JSON.parse(input) });
					expect(existsSync(join(spec.runDir, "broker.sock"))).toBe(true);
					return JSON.stringify({
						ok: true,
						result: { wake: false, note: "normal" },
					});
				},
			},
		});
		expect(
			await runner.run("export default () => ({})", scriptContext()),
		).toEqual({
			wake: false,
			note: "normal",
		});
		expect(scopes).toEqual([
			{ channel: "discord:owner", target: "owner", tier: "owner" },
		]);
		expect(runs[0]?.spec.workspaceReadOnly).toBe(true);
		const [run] = runs;
		expect(run?.input).toEqual({
			script: "export default () => ({})",
			firedAt: "2026-10-04T01:30:00.000Z",
			timeZone: "Asia/Taipei",
			today: "2026-10-04",
			schedule: { id: 13, title: "recovery" },
			servers: [{ name: "health", tools: ["garmin-login", "garmin-get-hrv"] }],
		});
		// The endpoint and the credential stay on the host.
		expect(JSON.stringify(run?.input)).not.toContain("mcp.example.test");
		expect(JSON.stringify(run?.input)).not.toContain("host-secret-token");
		expect(run?.spec.entrypoint).toEqual(PRECHECK_ENTRYPOINT);
		// Each run's socket and empty workspace are removed afterwards.
		expect(readdirSync(runRoot)).toEqual([]);
	});

	test("a script's failure throws its message, and describe tells the model what it may call", async () => {
		const runner = precheckScriptRunner({
			image: "sandbox:pi",
			runRoot: root(),
			uid: 1000,
			gid: 1000,
			grant: () => [HEALTH],
			driver: {
				exec: async () =>
					JSON.stringify({
						ok: false,
						error: "health/garmin-login: not logged in",
					}),
			},
		});
		await expect(
			runner.run("export default () => ({})", scriptContext()),
		).rejects.toThrow("health/garmin-login: not logged in");
		const guide = await runner.describe({
			channel: "discord:owner",
			target: "owner",
		});
		expect(guide).toContain("- health: garmin-login, garmin-get-hrv");
		expect(guide).toContain("`today` is the date in the host's time zone");
		expect(
			await precheckScriptRunner({
				image: "sandbox:pi",
				runRoot: root(),
				uid: 1000,
				gid: 1000,
				grant: () => [],
			}).describe({ channel: "discord:owner", target: "owner" }),
		).toContain("can call no MCP server");
	});

	test("refuses a grant with a cleartext or credential-bearing endpoint", async () => {
		const runner = precheckScriptRunner({
			image: "sandbox:pi",
			runRoot: root(),
			uid: 1000,
			gid: 1000,
			grant: () => [{ ...HEALTH, url: "http://user:pw@mcp.example.test/mcp" }],
		});
		await expect(
			runner.run("export default () => ({})", scriptContext()),
		).rejects.toThrow("credential-free HTTPS");
	});
});

describe("the precheck worker, outside a container", () => {
	async function runWorker(
		script: string,
		servers: PrecheckMcpServer[],
		fetchImpl: (url: string, init: RequestInit) => Promise<Response>,
	) {
		const dir = root();
		const socket = join(dir, "broker.sock");
		const listener = await listenBroker(
			socket,
			precheckBroker({
				servers,
				signal: new AbortController().signal,
				maxCalls: 8,
				fetchImpl,
			}),
		);
		try {
			const input: PrecheckWorkerInput = {
				script,
				firedAt: "2026-10-04T01:30:00.000Z",
				timeZone: "Asia/Taipei",
				today: "2026-10-04",
				schedule: { id: 13, title: "recovery" },
				servers: servers.map(({ name, tools }) => ({
					name,
					tools: [...tools],
				})),
			};
			const child = Bun.spawn(["bun", WORKER], {
				stdin: "pipe",
				stdout: "pipe",
				env: {
					HOME: dir,
					TMPDIR: dir,
					PRECHECK_BROKER_SOCKET: socket,
					PATH: process.env.PATH ?? "",
				},
			});
			child.stdin.write(JSON.stringify(input));
			child.stdin.end();
			const output = await new Response(child.stdout).text();
			expect(await child.exited).toBe(0);
			return JSON.parse(output) as {
				ok: boolean;
				result?: unknown;
				error?: string;
			};
		} finally {
			await listener.stop(true);
		}
	}

	test("runs the default export with mcp, today, and the schedule, through the broker", async () => {
		const { seen, fetchImpl } = upstream({
			"garmin-login": { status: "already_logged_in" },
			"garmin-get-hrv": {
				hrvSummary: { lastNightAvg: 22 },
				baseline: { balancedLow: 26 },
			},
		});
		const answer = await runWorker(
			`export default async ({ mcp, today, schedule }) => {
				await mcp.call("health", "garmin-login", {});
				const hrv = await mcp.json("health", "garmin-get-hrv", { date: today });
				setInterval(() => {}, 1000); // left behind; the worker still exits
				return hrv.hrvSummary.lastNightAvg < hrv.baseline.balancedLow
					? { wake: true, context: \`#\${schedule.id} \${today}: HRV \${hrv.hrvSummary.lastNightAvg}\` }
					: { wake: false };
			};`,
			[HEALTH],
			fetchImpl,
		);
		expect(answer).toEqual({
			ok: true,
			result: { wake: true, context: "#13 2026-10-04: HRV 22" },
		});
		expect(seen.map((s) => s.body.params)).toEqual([
			{ name: "garmin-login", arguments: {} },
			{ name: "garmin-get-hrv", arguments: { date: "2026-10-04" } },
		]);
	}, 20_000);

	test("a tool it was not granted, a tool error, and a missing default export come back as failures", async () => {
		const { fetchImpl } = upstream({});
		expect(
			await runWorker(
				`export default async ({ mcp }) => mcp.call("health", "garmin-delete-everything", {});`,
				[HEALTH],
				fetchImpl,
			),
		).toEqual({
			ok: false,
			error: "health/garmin-delete-everything is not granted to this script",
		});
		expect(
			await runWorker(
				`export default async ({ mcp }) => mcp.call("health", "garmin-login", {});`,
				[HEALTH],
				async () =>
					Response.json({
						jsonrpc: "2.0",
						id: 1,
						result: {
							isError: true,
							content: [{ type: "text", text: "Not logged in" }],
						},
					}),
			),
		).toEqual({ ok: false, error: "health/garmin-login: Not logged in" });
		expect(
			await runWorker(
				`const check = () => { console.log("noise"); console.info({ a: 1 }); return { wake: false, note: "ok" }; };
				export { check as default };`,
				[HEALTH],
				fetchImpl,
			),
		).toEqual({ ok: true, result: { wake: false, note: "ok" } });
		expect(await runWorker("export const x = 1;", [HEALTH], fetchImpl)).toEqual(
			{
				ok: false,
				error: "the script has no default export function",
			},
		);
	}, 20_000);
});
