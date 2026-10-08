import { expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { precheckScriptRunner } from "./precheck-runner.ts";
import { isRecord } from "./protocol.ts";
import { SandboxRuntime } from "./runtime.ts";

/** Docker Desktop does not share host Unix sockets into Linux containers; run on a native Linux host. */
test.skipIf(
	process.env.SANDBOX_DOCKER_TEST !== "1" || process.platform !== "linux",
)(
	"Docker builds the image and runs a sealed turn against a fake host model",
	async () => {
		const root = mkdtempSync(join(tmpdir(), "sb-docker-"));
		const image = "pi-roundtable-sandbox:test";
		const hostileImage = "pi-roundtable-sandbox:hostile-test";
		let hostile: SandboxRuntime | undefined;
		let modelCalls = 0;
		const endpoint = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: async (request) => {
				modelCalls++;
				expect(request.headers.get("authorization")).toBe(
					"Bearer integration-host-key",
				);
				const body: unknown = await request.json();
				if (!isRecord(body)) throw new Error("invalid test request");
				expect(body.model).toBe("fake-model");
				expect(JSON.stringify(body)).not.toContain("integration-host-key");
				return Response.json({
					choices: [
						{
							message: {
								role: "assistant",
								content: "Hello from the sealed worker.",
							},
						},
					],
				});
			},
		});
		const runtime = new SandboxRuntime({
			image,
			runRoot: join(root, "run"),
			workspaceRoot: join(root, "work"),
			model: "fake-model",
			modelUrl: `http://127.0.0.1:${endpoint.port}/v1/chat/completions`,
			apiKey: () => "integration-host-key",
			allowHttp: true,
		});
		try {
			const build = Bun.spawn(
				["docker", "build", "-f", "worker/Dockerfile", "-t", image, "."],
				{ stdout: "inherit", stderr: "inherit" },
			);
			expect(await build.exited).toBe(0);
			expect(
				await runtime.runTurn(
					"fake:guests",
					{ id: "guest", name: "Guest" },
					"Hello",
				),
			).toEqual({ ok: true, text: "Hello from the sealed worker." });
			expect(modelCalls).toBe(1);
			writeFileSync(
				join(root, "Dockerfile"),
				`FROM ${image}\nENTRYPOINT ["bun", "-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"]\n`,
			);
			expect(
				await Bun.spawn(["docker", "build", "-t", hostileImage, root], {
					stdout: "inherit",
					stderr: "inherit",
				}).exited,
			).toBe(0);
			hostile = new SandboxRuntime({
				image: hostileImage,
				runRoot: join(root, "hostile-run"),
				workspaceRoot: join(root, "hostile-work"),
				model: "fake-model",
				modelUrl: `http://127.0.0.1:${endpoint.port}/chat`,
				apiKey: () => "integration-host-key",
				allowHttp: true,
				turnTimeoutMs: 1000,
			});
			const started = Date.now();
			await expect(
				hostile.runTurn(
					"fake:hostile",
					{ id: "guest", name: "Guest" },
					"Hello",
				),
			).rejects.toThrow();
			expect(Date.now() - started).toBeLessThan(8000);
			const remaining = Bun.spawn(
				[
					"docker",
					"ps",
					"-a",
					"--filter",
					`ancestor=${hostileImage}`,
					"--format",
					"{{.Names}}",
				],
				{ stdout: "pipe" },
			);
			expect((await new Response(remaining.stdout).text()).trim()).toBe("");
			expect(await remaining.exited).toBe(0);
		} finally {
			await hostile?.dispose();
			await runtime.dispose();
			await endpoint.stop(true);
			rmSync(root, { recursive: true, force: true });
			await Bun.spawn(["docker", "image", "rm", hostileImage, image], {
				stdout: "ignore",
				stderr: "ignore",
			}).exited;
		}
	},
	300_000,
);

/** A precheck script runs sealed: no network of its own, only the broker's granted MCP tools. */
test.skipIf(
	process.env.SANDBOX_DOCKER_TEST !== "1" || process.platform !== "linux",
)(
	"Docker runs a precheck script that reaches its granted MCP tool only through the broker",
	async () => {
		const root = mkdtempSync(join(tmpdir(), "sb-precheck-"));
		const image = "pi-roundtable-sandbox:precheck-test";
		let mcpCalls = 0;
		const mcp = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: async (request) => {
				mcpCalls++;
				expect(request.headers.get("authorization")).toBe(
					"Bearer integration-mcp-token",
				);
				const body: unknown = await request.json();
				if (!isRecord(body) || !isRecord(body.params))
					throw new Error("invalid test request");
				expect(body.params.name).toBe("get-hrv");
				return Response.json({
					jsonrpc: "2.0",
					id: 1,
					result: {
						content: [
							{ type: "text", text: JSON.stringify({ lastNightAvg: 22 }) },
						],
					},
				});
			},
		});
		try {
			const build = Bun.spawn(
				["docker", "build", "-f", "worker/Dockerfile", "-t", image, "."],
				{ stdout: "inherit", stderr: "inherit" },
			);
			expect(await build.exited).toBe(0);
			const runRoot = join(root, "run");
			mkdirSync(runRoot, { mode: 0o700 });
			const runner = precheckScriptRunner({
				image,
				runRoot,
				uid: process.getuid?.() ?? 0,
				gid: process.getgid?.() ?? 0,
				entrypoint: ["bun", "/app/worker/precheck-main.ts"],
				allowHttpMcp: true,
				grant: () => [
					{
						name: "health",
						url: `http://127.0.0.1:${mcp.port}/mcp`,
						tools: ["get-hrv"],
						token: () => "integration-mcp-token",
					},
				],
			});
			const script = `export default async ({ mcp, today }) => {
				let direct = "reached";
				try {
					await fetch("http://127.0.0.1:${mcp.port}/mcp", { signal: AbortSignal.timeout(3000) });
				} catch {
					direct = "blocked";
				}
				const hrv = await mcp.json("health", "get-hrv", { date: today });
				return { wake: true, context: direct + " " + today + " " + hrv.lastNightAvg };
			};`;
			const result = await runner.run(script, {
				schedule: {
					id: 1,
					title: "recovery",
					channel: "fake:owner",
					target: "owner",
					prompt: "p",
					recurrence: {
						kind: "every",
						time: "09:30",
						everyDays: 1,
						startDate: "2026-10-01",
					},
					nextRun: new Date(),
					createdById: "owner",
					createdByName: "Owner",
					createdTier: "owner",
					createdAt: new Date(),
				},
				firedAt: new Date("2026-10-04T01:30:00Z"),
				tier: "owner",
				timeZone: "Asia/Taipei",
				today: "2026-10-04",
				tools: [{ server: "health", tool: "get-hrv" }],
				signal: AbortSignal.timeout(60_000),
			});
			expect(result).toEqual({ wake: true, context: "blocked 2026-10-04 22" });
			expect(mcpCalls).toBe(1);
			expect(readdirSync(runRoot)).toEqual([]);
		} finally {
			await mcp.stop(true);
			rmSync(root, { recursive: true, force: true });
			await Bun.spawn(["docker", "image", "rm", image], {
				stdout: "ignore",
				stderr: "ignore",
			}).exited;
		}
	},
	300_000,
);
