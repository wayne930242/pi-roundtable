import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { unixBrokerRequest } from "../worker/transport.ts";
import { SandboxRuntime, type SandboxRuntimeOptions } from "./runtime.ts";

function options(root: string): SandboxRuntimeOptions {
	return {
		image: "sandbox:fake",
		runRoot: join(root, "run"),
		workspaceRoot: join(root, "work"),
		model: "fake",
		modelUrl: "https://models.example/chat",
		apiKey: () => "host-key",
		driver: { run: async () => ({ ok: true, text: "done" }) },
	};
}

test("runtime fixes identity, creates disjoint channel mounts and removes broker mounts after each turn", async () => {
	const root = mkdtempSync("/tmp/sb-runtime-");
	const workspaces: string[] = [];
	const runtime = new SandboxRuntime({
		...options(root),
		tools: [
			{
				name: "identity",
				description: "Identity",
				parameters: { type: "object" },
				run: (_input, context) => `${context.channel}/${context.speaker.id}`,
			},
		],
		driver: {
			run: async (spec, turn) => {
				workspaces.push(spec.workspaceDir);
				expect(JSON.stringify(turn)).not.toContain("host-key");
				const response = await unixBrokerRequest(
					"/tools/identity",
					{ speaker: { id: "owner" }, channel: "fake:private" },
					join(spec.runDir, "broker.sock"),
				);
				expect(response.body).toEqual({ text: `fake:${turn.text}/guest` });
				return { ok: true, text: "done" };
			},
		},
	});
	try {
		await runtime.runTurn("fake:a", { id: "guest", name: "Guest" }, "a");
		await runtime.runTurn("fake:b", { id: "guest", name: "Guest" }, "b");
		expect(workspaces[0]).not.toBe(workspaces[1]);
		expect(readdirSync(join(root, "run"))).toEqual([]);
		expect(readdirSync(join(root, "work")).length).toBe(2);
	} finally {
		await runtime.dispose();
		rmSync(root, { recursive: true, force: true });
	}
});

test("stop and disposal abort only running turns and cleanup their broker directories", async () => {
	const root = mkdtempSync("/tmp/sb-runtime-");
	let started: (() => void) | undefined;
	const ready = new Promise<void>((resolve) => {
		started = resolve;
	});
	const runtime = new SandboxRuntime({
		...options(root),
		driver: {
			run: async (_spec, _turn, signal) => {
				started?.();
				return new Promise((resolve) => {
					signal.addEventListener(
						"abort",
						() => resolve({ ok: false, text: "stopped" }),
						{ once: true },
					);
				});
			},
		},
	});
	try {
		const turn = runtime.runTurn("fake:a", { id: "guest", name: "Guest" }, "a");
		await ready;
		expect(runtime.stop("fake:other")).toBe(false);
		expect(runtime.stop("fake:a")).toBe(true);
		expect(await turn).toEqual({ ok: false, text: "stopped" });
		expect(runtime.busy()).toEqual([]);
		expect(readdirSync(join(root, "run"))).toEqual([]);
		await runtime.dispose();
		await expect(
			runtime.runTurn("fake:a", { id: "guest", name: "Guest" }, "a"),
		).rejects.toThrow();
	} finally {
		await runtime.dispose();
		rmSync(root, { recursive: true, force: true });
	}
});

test("unsafe roots, user mappings and timeout options are refused before a turn", () => {
	const root = mkdtempSync("/tmp/sb-runtime-");
	try {
		for (const override of [
			{ runRoot: "relative" },
			{ workspaceRoot: join(root, "run") },
			{ uid: 0 },
			{ gid: 0 },
			{ turnTimeoutMs: -1 },
			{ limits: { cpus: 0 } },
			{ timeZone: "not-a-zone" },
		])
			expect(
				() => new SandboxRuntime({ ...options(root), ...override }),
			).toThrow();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
