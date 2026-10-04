import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { ContainerSpec } from "./container-driver.ts";
import type { SandboxReply } from "./protocol.ts";
import { SandboxRuntime, type SandboxRuntimeOptions } from "./runtime.ts";

function options(root: string): SandboxRuntimeOptions {
	return {
		image: "sandbox:fake",
		runRoot: join(root, "run"),
		workspaceRoot: join(root, "work"),
		model: "fake",
		modelUrl: "https://models.example/chat",
		apiKey: () => undefined,
		driver: { run: async () => ({ ok: true, text: "done" }) },
	};
}

for (const failure of ["reply", "throw"] as const) {
	test(`a driver ${failure} cleans temporary resources and preserves workspace and reset for retry`, async () => {
		const root = mkdtempSync("/tmp/sb-runtime-life-");
		const resets: boolean[] = [];
		const specs: ContainerSpec[] = [];
		const runtime = new SandboxRuntime({
			...options(root),
			driver: {
				run: async (spec, turn) => {
					specs.push(spec);
					resets.push(turn.reset === true);
					if (specs.length === 1) {
						await Bun.write(join(spec.workspaceDir, "note.txt"), "keep me");
						if (failure === "throw") throw new Error("driver failed");
						return { ok: false, text: "failed" };
					}
					return { ok: true, text: "done" };
				},
			},
		});
		try {
			runtime.startFresh("fake:a");
			const first = runtime.runTurn(
				"fake:a",
				{ id: "guest", name: "Guest" },
				"first",
			);
			if (failure === "throw")
				await expect(first).rejects.toThrow("driver failed");
			else expect(await first).toEqual({ ok: false, text: "failed" });
			expect(runtime.busy()).toEqual([]);
			expect(readdirSync(join(root, "run"))).toEqual([]);
			expect(
				await Bun.file(join(specs[0]?.workspaceDir ?? "", "note.txt")).text(),
			).toBe("keep me");
			await runtime.runTurn("fake:a", { id: "guest", name: "Guest" }, "retry");
			await runtime.runTurn("fake:a", { id: "guest", name: "Guest" }, "next");
			expect(resets).toEqual([true, true, false]);
			expect(specs[1]?.workspaceDir).toBe(specs[0]?.workspaceDir);
			expect(specs[1]?.runDir).not.toBe(specs[0]?.runDir);
			expect(readdirSync(join(root, "run"))).toEqual([]);
		} finally {
			await runtime.dispose();
			rmSync(root, { recursive: true, force: true });
		}
	});
}

test("channels run independently but reject overlap in the same channel", async () => {
	const root = mkdtempSync("/tmp/sb-runtime-life-");
	const releases: ((reply: SandboxReply) => void)[] = [];
	let started = () => {};
	const firstStarted = new Promise<void>((resolve) => {
		started = resolve;
	});
	let secondStarted = () => {};
	const bothStarted = new Promise<void>((resolve) => {
		secondStarted = resolve;
	});
	const runtime = new SandboxRuntime({
		...options(root),
		driver: {
			run: () =>
				new Promise((resolve) => {
					releases.push(resolve);
					if (releases.length === 1) started();
					else secondStarted();
				}),
		},
	});
	try {
		const first = runtime.runTurn(
			"fake:a",
			{ id: "guest", name: "Guest" },
			"first",
		);
		await firstStarted;
		await expect(
			runtime.runTurn("fake:a", { id: "guest", name: "Guest" }, "overlap"),
		).rejects.toThrow("channel is busy");
		const second = runtime.runTurn(
			"fake:b",
			{ id: "guest", name: "Guest" },
			"second",
		);
		await bothStarted;
		expect(runtime.busy().sort()).toEqual(["fake:a", "fake:b"]);
		expect(readdirSync(join(root, "run"))).toHaveLength(2);
		for (const release of releases) release({ ok: true, text: "done" });
		await Promise.all([first, second]);
		expect(runtime.busy()).toEqual([]);
		expect(readdirSync(join(root, "run"))).toEqual([]);
	} finally {
		for (const release of releases) release({ ok: false, text: "cleanup" });
		await runtime.dispose();
		rmSync(root, { recursive: true, force: true });
	}
});

test("normalizes options once and retains the admitted speaker through broker startup", async () => {
	const root = mkdtempSync("/tmp/sb-runtime-life-");
	const speaker = { id: "guest", name: "Guest" };
	const runtime = new SandboxRuntime({
		...options(root),
		runRoot: join(root, "run", "..", "run"),
		prompt: "Use the supplied tools",
		timeZone: "Asia/Taipei",
		limits: { memoryMb: 256, cpus: 0.5, pids: 32 },
		driver: {
			run: async (spec, turn) => {
				expect(spec.uid).toBe(process.getuid?.() ?? 0);
				expect(spec.gid).toBe(process.getgid?.() ?? 0);
				expect(spec).toMatchObject({ memoryMb: 256, cpus: 0.5, pids: 32 });
				expect(turn).toMatchObject({
					text: "hello",
					speaker: { id: "guest", name: "Guest" },
					model: "fake",
					prompt: "Use the supplied tools",
					timeZone: "Asia/Taipei",
					reset: false,
					tools: [],
					mcp: [],
				});
				return { ok: true, text: "done" };
			},
		},
	});
	try {
		const turn = runtime.runTurn("fake:a", speaker, "hello");
		speaker.id = "changed";
		expect(await turn).toEqual({ ok: true, text: "done" });
	} finally {
		await runtime.dispose();
		rmSync(root, { recursive: true, force: true });
	}
});
