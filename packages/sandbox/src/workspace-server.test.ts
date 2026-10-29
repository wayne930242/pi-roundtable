import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { IDENTITY, type Speaker } from "pi-roundtable";
import { servicePair, testPlugin } from "pi-roundtable/testing";
import type { ContainerSpec } from "./container-driver.ts";
import { channelStateDir, guildWorkspaceDir } from "./layout.ts";
import { sandbox } from "./plugin.ts";
import type { SandboxTurn } from "./protocol.ts";
import { SandboxRuntime, type SandboxRuntimeOptions } from "./runtime.ts";
import { resolveSandboxRuntimeOptions } from "./runtime-options.ts";

const speaker = { id: "guest", name: "Guest", principalId: "p_guest" };
const GUILD = "1479073413380440118";
const OTHER = "1381283461167317085";

interface Seen {
	spec: ContainerSpec;
	turn: SandboxTurn;
}

function setup(
	extra: Partial<SandboxRuntimeOptions> = {},
	run?: (
		spec: ContainerSpec,
		turn: SandboxTurn,
		signal: AbortSignal,
	) => Promise<{ ok: boolean; text: string }>,
) {
	const root = mkdtempSync("/tmp/sb-server-");
	const seen: Seen[] = [];
	const runtime = new SandboxRuntime({
		image: "sandbox:fake",
		runRoot: join(root, "run"),
		workspaceRoot: join(root, "work"),
		model: "fake",
		modelUrl: "https://models.example/chat",
		apiKey: () => "host-key",
		driver: {
			run: async (spec, turn, signal) => {
				seen.push({ spec, turn });
				return run ? run(spec, turn, signal) : { ok: true, text: "done" };
			},
		},
		...extra,
	});
	return { root, seen, runtime, work: join(root, "work") };
}

test("workspace channel (the default) keeps one workspace per channel, no channel mount and no new turn field", async () => {
	for (const workspace of [undefined, "channel" as const]) {
		const { root, seen, runtime } = setup({ workspace });
		try {
			await runtime.runTurn("discord:1", speaker, "a", { space: GUILD });
			await runtime.runTurn("discord:2", speaker, "b", { space: GUILD });
			expect(seen[0]?.spec.workspaceDir).not.toBe(seen[1]?.spec.workspaceDir);
			for (const entry of seen) {
				expect(entry.spec.channelDir).toBeUndefined();
				expect(entry.turn.historyDir).toBeUndefined();
			}
		} finally {
			await runtime.dispose();
			rmSync(root, { recursive: true, force: true });
		}
	}
});

test("workspace server shares one workspace per guild, keeps history in each channel's own state directory, and never shares across guilds", async () => {
	const { root, seen, runtime, work } = setup({ workspace: "server" });
	try {
		await runtime.runTurn("discord:1", speaker, "a", { space: GUILD });
		await runtime.runTurn("discord:2", speaker, "b", { space: GUILD });
		await runtime.runTurn("discord:3", speaker, "c", { space: OTHER });
		const real = (path: string) => path.replace(/^\/private/, "");
		expect(real(seen[0]?.spec.workspaceDir ?? "")).toBe(
			real(guildWorkspaceDir(work, "discord", GUILD)),
		);
		expect(seen[1]?.spec.workspaceDir).toBe(seen[0]?.spec.workspaceDir);
		expect(seen[2]?.spec.workspaceDir).not.toBe(seen[0]?.spec.workspaceDir);
		expect(real(seen[0]?.spec.channelDir ?? "")).toBe(
			real(channelStateDir(work, "discord:1")),
		);
		expect(seen[1]?.spec.channelDir).not.toBe(seen[0]?.spec.channelDir);
		for (const entry of seen) expect(entry.turn.historyDir).toBe("/channel");
		// Both directories exist, private, and are siblings under the root.
		for (const dir of [seen[0]?.spec.workspaceDir, seen[0]?.spec.channelDir])
			expect(statSync(dir ?? "").mode & 0o777).toBe(0o700);
		expect(readdirSync(work).length).toBe(5);
	} finally {
		await runtime.dispose();
		rmSync(root, { recursive: true, force: true });
	}
});

test("a server-mode turn whose message carries no guild keeps its own per-channel workspace", async () => {
	const { root, seen, runtime, work } = setup({ workspace: "server" });
	try {
		await runtime.runTurn("discord:dm-1", speaker, "a");
		await runtime.runTurn("discord:dm-1", speaker, "b", {});
		for (const entry of seen) {
			expect(entry.spec.channelDir).toBeUndefined();
			expect(entry.turn.historyDir).toBeUndefined();
		}
		expect(readdirSync(work).length).toBe(1);
	} finally {
		await runtime.dispose();
		rmSync(root, { recursive: true, force: true });
	}
});

test("an invalid workspace value stops startup", () => {
	const { root } = setup();
	try {
		expect(() =>
			resolveSandboxRuntimeOptions({
				image: "sandbox:fake",
				runRoot: join(root, "run"),
				workspaceRoot: join(root, "work"),
				model: "fake",
				modelUrl: "https://models.example/chat",
				apiKey: () => "k",
				driver: { run: async () => ({ ok: true, text: "" }) },
				workspace: "guild" as never,
			}),
		).toThrow("workspace");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

function gate() {
	let open!: () => void;
	const promise = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { open, promise };
}

test("turns sharing a workspace run one at a time in arrival order; other workspaces run alongside", async () => {
	const gates = new Map<string, ReturnType<typeof gate>>();
	const log: string[] = [];
	const { root, runtime } = setup(
		{ workspace: "server" },
		async (_spec, turn) => {
			log.push(`start ${turn.text}`);
			const g = gate();
			gates.set(turn.text, g);
			await g.promise;
			log.push(`end ${turn.text}`);
			return { ok: true, text: turn.text };
		},
	);
	try {
		const a = runtime.runTurn("discord:1", speaker, "a", { space: GUILD });
		const b = runtime.runTurn("discord:2", speaker, "b", { space: GUILD });
		const c = runtime.runTurn("discord:3", speaker, "c", { space: GUILD });
		const other = runtime.runTurn("discord:4", speaker, "other", {
			space: OTHER,
		});
		await Bun.sleep(100);
		expect(log).toEqual(["start a", "start other"]);
		expect(runtime.busy().sort()).toEqual([
			"discord:1",
			"discord:2",
			"discord:3",
			"discord:4",
		]);
		gates.get("a")?.open();
		await a;
		await Bun.sleep(50);
		expect(log).toEqual(["start a", "start other", "end a", "start b"]);
		gates.get("b")?.open();
		await b;
		await Bun.sleep(50);
		expect(log.at(-1)).toBe("start c");
		gates.get("c")?.open();
		gates.get("other")?.open();
		expect(await c).toEqual({ ok: true, text: "c" });
		await other;
		expect(runtime.busy()).toEqual([]);
	} finally {
		await runtime.dispose();
		rmSync(root, { recursive: true, force: true });
	}
});

test("a second turn for a channel with one running or waiting is still refused as busy", async () => {
	const g = gate();
	const { root, runtime } = setup({ workspace: "server" }, async () => {
		await g.promise;
		return { ok: true, text: "done" };
	});
	try {
		const first = runtime.runTurn("discord:1", speaker, "a", { space: GUILD });
		const waiting = runtime.runTurn("discord:2", speaker, "b", {
			space: GUILD,
		});
		await expect(
			runtime.runTurn("discord:1", speaker, "x", { space: GUILD }),
		).rejects.toThrow("busy");
		await expect(
			runtime.runTurn("discord:2", speaker, "x", { space: GUILD }),
		).rejects.toThrow("busy");
		g.open();
		await first;
		await waiting;
	} finally {
		await runtime.dispose();
		rmSync(root, { recursive: true, force: true });
	}
});

test("the turn timeout starts when a turn begins running, not while it waits", async () => {
	const { root, runtime } = setup(
		{ workspace: "server", turnTimeoutMs: 1000 },
		async (_spec, turn, signal) => {
			if (turn.text === "slow") await Bun.sleep(700);
			return { ok: !signal.aborted, text: turn.text };
		},
	);
	try {
		const slow = runtime.runTurn("discord:1", speaker, "slow", {
			space: GUILD,
		});
		const second = runtime.runTurn("discord:2", speaker, "second", {
			space: GUILD,
		});
		const third = runtime.runTurn("discord:3", speaker, "third", {
			space: GUILD,
		});
		// third waited ~1.4 s, longer than the timeout, yet runs unaborted.
		await slow;
		await second;
		await Bun.sleep(1);
		expect(await third).toEqual({ ok: true, text: "third" });
	} finally {
		await runtime.dispose();
		rmSync(root, { recursive: true, force: true });
	}
});

test("a running turn that outlives the timeout is still aborted", async () => {
	const { root, runtime } = setup(
		{ workspace: "server", turnTimeoutMs: 1000 },
		async (_spec, _turn, signal) => {
			await new Promise<void>((resolve) =>
				signal.addEventListener("abort", () => resolve(), { once: true }),
			);
			return { ok: false, text: "timed out" };
		},
	);
	try {
		expect(
			await runtime.runTurn("discord:1", speaker, "a", { space: GUILD }),
		).toEqual({ ok: false, text: "timed out" });
	} finally {
		await runtime.dispose();
		rmSync(root, { recursive: true, force: true });
	}
});

test("stop cancels a waiting turn as well as a running one, and the queue keeps its order behind a cancelled turn", async () => {
	const gates = new Map<string, ReturnType<typeof gate>>();
	const log: string[] = [];
	const { root, runtime } = setup(
		{ workspace: "server" },
		async (_spec, turn, signal) => {
			log.push(`start ${turn.text}`);
			const g = gate();
			gates.set(turn.text, g);
			await Promise.race([
				g.promise,
				new Promise((resolve) =>
					signal.addEventListener("abort", resolve, { once: true }),
				),
			]);
			return { ok: !signal.aborted, text: turn.text };
		},
	);
	try {
		const a = runtime.runTurn("discord:1", speaker, "a", { space: GUILD });
		const b = runtime.runTurn("discord:2", speaker, "b", { space: GUILD });
		const c = runtime.runTurn("discord:3", speaker, "c", { space: GUILD });
		await Bun.sleep(50);
		expect(runtime.stop("discord:2")).toBe(true);
		await expect(b).rejects.toThrow();
		await Bun.sleep(50);
		// c still waits for a, even though b ahead of it left the queue.
		expect(log).toEqual(["start a"]);
		expect(runtime.busy().sort()).toEqual(["discord:1", "discord:3"]);
		gates.get("a")?.open();
		await a;
		await Bun.sleep(50);
		expect(log).toEqual(["start a", "start c"]);
		gates.get("c")?.open();
		expect(await c).toEqual({ ok: true, text: "c" });
		expect(runtime.stop("discord:2")).toBe(false);
	} finally {
		await runtime.dispose();
		rmSync(root, { recursive: true, force: true });
	}
});

test("disposal cancels waiting turns and leaves no run directory", async () => {
	const { root, runtime } = setup(
		{ workspace: "server" },
		async (_spec, _turn, signal) => {
			await new Promise<void>((resolve) => {
				if (signal.aborted) resolve();
				signal.addEventListener("abort", () => resolve(), { once: true });
			});
			return { ok: false, text: "stopped" };
		},
	);
	try {
		const a = runtime.runTurn("discord:1", speaker, "a", { space: GUILD });
		const b = runtime.runTurn("discord:2", speaker, "b", { space: GUILD });
		await Bun.sleep(30);
		const outcome = b.then(
			() => "resolved",
			(error: Error) => error.message,
		);
		await runtime.dispose();
		await a;
		expect(await outcome).toContain("stopped while waiting");
		expect(readdirSync(join(root, "run"))).toEqual([]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("through the plugin, two channels of a configured guild share the guild's workspace and keep their own state", async () => {
	const root = mkdtempSync("/tmp/sb-splugin-");
	const dirs: {
		workspaceDir: string;
		channelDir?: string;
		historyDir?: string;
	}[] = [];
	const served = servicePair(IDENTITY, {
		resolve: async () =>
			({
				id: "alice",
				name: "Alice",
				tier: "member",
				principalId: "p_alice",
			}) as Speaker,
	});
	const harness = await testPlugin(
		sandbox({
			image: "sandbox:local",
			runRoot: join(root, "run"),
			workspaceRoot: join(root, "work"),
			stateFile: join(root, "state", "channels.json"),
			model: "fake",
			modelUrl: "https://models.example/chat",
			provider: "p",
			guilds: [GUILD],
			workspace: "server",
			driver: {
				imageProtocol: async () => 2,
				run: async (spec, turn) => {
					dirs.push({
						workspaceDir: spec.workspaceDir,
						channelDir: spec.channelDir,
						historyDir: turn.historyDir,
					});
					return { ok: true, text: "Safe." };
				},
			},
		}),
		{
			services: [served],
			apiKeys: { p: "key" },
			surfaces: [
				{
					surface: "discord",
					start: async () => {},
					sendReply: async () => {},
				},
			],
		},
	);
	try {
		const message = {
			messageId: "m",
			authorId: "alice",
			authorName: "Alice",
			authorIsBot: false,
			isDirect: false,
			mentionsBot: true,
			repliesToBot: false,
			text: "hi",
			attachments: [],
			space: GUILD,
		};
		await harness.conversations.handle({ ...message, channel: "discord:11" });
		await harness.conversations.handle({ ...message, channel: "discord:12" });
		expect(dirs[0]?.workspaceDir).toBe(dirs[1]?.workspaceDir);
		expect(dirs[0]?.channelDir).not.toBe(dirs[1]?.channelDir);
		expect(dirs.map((entry) => entry.historyDir)).toEqual([
			"/channel",
			"/channel",
		]);
	} finally {
		await harness.stop();
		rmSync(root, { recursive: true, force: true });
	}
});
