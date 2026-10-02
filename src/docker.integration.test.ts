import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
