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
		await runtime.runTurn(
			"fake:a",
			{ id: "guest", name: "Guest", principalId: "p_guest" },
			"a",
		);
		await runtime.runTurn(
			"fake:b",
			{ id: "guest", name: "Guest", principalId: "p_guest" },
			"b",
		);
		expect(workspaces[0]).not.toBe(workspaces[1]);
		expect(readdirSync(join(root, "run"))).toEqual([]);
		expect(readdirSync(join(root, "work")).length).toBe(2);
	} finally {
		await runtime.dispose();
		rmSync(root, { recursive: true, force: true });
	}
});

test.each([false, true])(
	"startFresh during an active turn survives its completion (already fresh: %s)",
	async (alreadyFresh) => {
		const root = mkdtempSync("/tmp/sb-runtime-");
		const resets: boolean[] = [];
		const runtime = new SandboxRuntime({
			...options(root),
			driver: {
				run: async (_spec, turn) => {
					resets.push(turn.reset === true);
					if (turn.text === "active") runtime.startFresh("fake:a");
					return { ok: true, text: "done" };
				},
			},
		});
		try {
			if (alreadyFresh) runtime.startFresh("fake:a");
			await runtime.runTurn(
				"fake:a",
				{ id: "guest", name: "Guest", principalId: "p_guest" },
				"active",
			);
			await runtime.runTurn(
				"fake:a",
				{ id: "guest", name: "Guest", principalId: "p_guest" },
				"next",
			);
			await runtime.runTurn(
				"fake:a",
				{ id: "guest", name: "Guest", principalId: "p_guest" },
				"settled",
			);
			expect(resets).toEqual([alreadyFresh, true, false]);
		} finally {
			await runtime.dispose();
			rmSync(root, { recursive: true, force: true });
		}
	},
);

test("startFresh during broker startup is reserved for the next turn", async () => {
	const root = mkdtempSync("/tmp/sb-runtime-");
	const resets: boolean[] = [];
	const runtime = new SandboxRuntime({
		...options(root),
		driver: {
			run: async (_spec, turn) => {
				resets.push(turn.reset === true);
				return { ok: true, text: "done" };
			},
		},
	});
	try {
		const active = runtime.runTurn(
			"fake:a",
			{ id: "guest", name: "Guest", principalId: "p_guest" },
			"active",
		);
		runtime.startFresh("fake:a");
		await active;
		await runtime.runTurn(
			"fake:a",
			{ id: "guest", name: "Guest", principalId: "p_guest" },
			"next",
		);
		expect(resets).toEqual([false, true]);
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
		const turn = runtime.runTurn(
			"fake:a",
			{ id: "guest", name: "Guest", principalId: "p_guest" },
			"a",
		);
		await ready;
		expect(runtime.stop("fake:other")).toBe(false);
		expect(runtime.stop("fake:a")).toBe(true);
		expect(await turn).toEqual({ ok: false, text: "stopped" });
		expect(runtime.busy()).toEqual([]);
		expect(readdirSync(join(root, "run"))).toEqual([]);
		await runtime.dispose();
		await expect(
			runtime.runTurn(
				"fake:a",
				{ id: "guest", name: "Guest", principalId: "p_guest" },
				"a",
			),
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

test("the runtime hands the admitted principal to host tools and the credential hook, never to the worker", async () => {
	const root = mkdtempSync("/tmp/sb-runtime-");
	const scopes: unknown[] = [];
	const model = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () => Response.json({ choices: [] }),
	});
	const runtime = new SandboxRuntime({
		...options(root),
		modelUrl: `http://127.0.0.1:${model.port}/chat`,
		allowHttp: true,
		apiKey: (scope) => {
			scopes.push(scope);
			return "host-key";
		},
		tools: [
			{
				name: "whom",
				description: "Whom the turn is for",
				parameters: { type: "object" },
				run: (_input, context) => JSON.stringify(context.speaker),
			},
		],
		driver: {
			run: async (spec, turn) => {
				expect(turn.speaker).toEqual({ id: "guest", name: "Guest" });
				const socket = join(spec.runDir, "broker.sock");
				const tool = await unixBrokerRequest(
					"/tools/whom",
					{ speaker: { principalId: "owner" } },
					socket,
				);
				expect(tool.body).toEqual({
					text: JSON.stringify({
						id: "guest",
						name: "Guest",
						principalId: "p_guest",
					}),
				});
				expect(
					(await unixBrokerRequest("/model", { messages: [] }, socket)).status,
				).toBe(200);
				return { ok: true, text: "done" };
			},
		},
	});
	try {
		await runtime.runTurn(
			"fake:a",
			{ id: "guest", name: "Guest", principalId: "p_guest" },
			"a",
		);
		expect(scopes).toEqual([
			{
				channel: "fake:a",
				speaker: { id: "guest", name: "Guest", principalId: "p_guest" },
			},
		]);
	} finally {
		await runtime.dispose();
		await model.stop(true);
		rmSync(root, { recursive: true, force: true });
	}
});

test("a turn without the principal its speaker was admitted as is refused", async () => {
	const root = mkdtempSync("/tmp/sb-runtime-");
	let runs = 0;
	const runtime = new SandboxRuntime({
		...options(root),
		driver: {
			run: async () => {
				runs++;
				return { ok: true, text: "done" };
			},
		},
	});
	try {
		for (const principalId of ["", "p".repeat(257), undefined])
			await expect(
				runtime.runTurn(
					"fake:a",
					// SAFETY: a caller outside the type checker may leave the principal out.
					{ id: "guest", name: "Guest", principalId } as never,
					"a",
				),
			).rejects.toThrow();
		expect(runs).toBe(0);
	} finally {
		await runtime.dispose();
		rmSync(root, { recursive: true, force: true });
	}
});
