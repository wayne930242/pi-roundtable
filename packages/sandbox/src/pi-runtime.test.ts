import { expect, test } from "bun:test";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { channelSegment } from "pi-roundtable/kit";
import { silentLogger } from "pi-roundtable/testing";
import type {
	PiContainerDriver,
	PiContainerSpec,
} from "./pi-container-driver.ts";
import { piContainerCreateBody } from "./pi-container-driver.ts";
import {
	PiSandboxRuntime,
	type PiSandboxRuntimeOptions,
} from "./pi-runtime.ts";

function fixture(
	cancel = false,
	overrides: Partial<PiSandboxRuntimeOptions> = {},
) {
	const root = realpathSync(mkdtempSync("/tmp/pi-sbx-"));
	const workerTurns: unknown[] = [];
	const modelStatuses: number[] = [];
	const removed: string[] = [];
	let tasks: Promise<void>[] = [];
	let signal: AbortController | undefined;
	const driver: PiContainerDriver = {
		status: async () => ({ state: "running" }),
		remove: async (name) => {
			removed.push(name);
			signal?.abort();
		},
		ensureRunning: async (spec: PiContainerSpec) => {
			if (signal) return;
			signal = new AbortController();
			const unix = join(spec.runDir, "broker.sock");
			const ready = await fetch("http://broker/worker/ready", {
				unix,
				method: "POST",
			});
			await ready.body?.cancel();
			tasks = [
				(async () => {
					for (let index = 0; index < (cancel ? 1 : 2); index++) {
						const response = await fetch("http://broker/worker/next", {
							unix,
							signal: signal?.signal,
						});
						const turn = (await response.json()) as {
							turnId: string;
							author: { id: string };
							memory: string;
							thinking: string;
						};
						workerTurns.push(turn);
						if (cancel) return;
						if (overrides.fetchImpl) {
							const model = await fetch("http://broker/anthropic/v1/messages", {
								unix,
								method: "POST",
								headers: { authorization: "Bearer guest-token" },
								body: JSON.stringify({
									messages: [{ role: "user", content: "Hello" }],
								}),
							});
							modelStatuses.push(model.status);
							await model.body?.cancel();
						}
						const sent = await fetch("http://broker/worker/result", {
							unix,
							method: "POST",
							body: JSON.stringify({
								turnId: turn.turnId,
								result: {
									ok: true,
									text: "done",
									files: [{ name: "art.png", data: "AQID" }],
								},
							}),
						});
						await sent.body?.cancel();
					}
				})().catch(() => {}),
			];
		},
	};
	const options: PiSandboxRuntimeOptions = {
		partyDir: root,
		image: "sandbox:test",
		driver,
		profiles: { profile: { model: "host-model" } },
		oauthToken: () => "host-secret",
		memory: { promptBlock: async (channel, id) => `${channel}:${id}` },
		effort: { judge: async (_text, previous) => previous.level ?? "high" },
		logger: silentLogger(),
		turnTimeoutMs: 1000,
		...overrides,
	};
	const runtime = new PiSandboxRuntime(options);
	return {
		root,
		runtime,
		options,
		workerTurns,
		modelStatuses,
		removed,
		close: async () => {
			signal?.abort();
			await runtime.stopBrokers();
			await Promise.all(tasks);
			rmSync(root, { recursive: true, force: true });
		},
	};
}
test("rich runtime retains JSONL/session/workspace paths, thinking and DB hook identities across turns", async () => {
	const f = fixture();
	const channel = "discord:123";
	const sessions = join(
		f.root,
		channelSegment(channel),
		"workspace",
		"sessions",
	);
	mkdirSync(sessions, { recursive: true });
	writeFileSync(join(sessions, "existing.jsonl"), "existing session\n");
	try {
		expect(f.runtime.sessionsDir(channel)).toBe(sessions);
		for (const id of ["a", "b"]) {
			const result = await f.runtime.runTurn({
				channel,
				profile: "profile",
				turnId: id,
				author: { id, name: id },
				text: "hello",
				images: [],
			});
			expect(result).toMatchObject({
				ok: true,
				text: "done",
				files: [{ name: "art.png", data: new Uint8Array([1, 2, 3]) }],
			});
		}
		expect(f.workerTurns).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					author: { id: "a", name: "a" },
					memory: "discord:123:a",
					thinking: "high",
				}),
				expect.objectContaining({
					author: { id: "b", name: "b" },
					memory: "discord:123:b",
					thinking: "high",
				}),
			]),
		);
		expect(readFileSync(join(sessions, "existing.jsonl"), "utf8")).toBe(
			"existing session\n",
		);
	} finally {
		await f.close();
	}
});
test("cancellation removes the exact channel container and deactivates the broker", async () => {
	const f = fixture(true);
	const controller = new AbortController();
	try {
		const done = f.runtime.runTurn({
			channel: "discord:cancel",
			profile: "profile",
			turnId: "m",
			author: { id: "guest", name: "Guest" },
			text: "hello",
			images: [],
			signal: controller.signal,
		});
		// Wait for the host-created broker to deliver the turn, not a guest socket file.
		await f.runtime.start("discord:cancel", "profile");
		controller.abort();
		expect((await done).ok).toBe(false);
		expect(f.removed).toEqual([
			`roundtable-sandbox-${channelSegment("discord:cancel")}`,
		]);
	} finally {
		await f.close();
	}
});
test("legacy channelSegment collisions are refused without changing existing workspace names", async () => {
	const f = fixture();
	try {
		f.runtime.attachmentDir("discord:a:b");
		expect(() => f.runtime.attachmentDir("discord:a_b")).toThrow("alias");
	} finally {
		await f.close();
	}
});

test("start fresh never moves host files through guest-planted symlinks and a hostile entry does not brick the channel", async () => {
	const f = fixture();
	const outside = realpathSync(mkdtempSync("/tmp/pi-outside-"));
	try {
		const channel = "discord:fresh";
		const sessions = f.runtime.sessionsDir(channel);
		const workspace = join(sessions, "..");
		mkdirSync(workspace, { recursive: true });
		writeFileSync(join(outside, "owner-session.jsonl"), "owner\n");
		// sessions itself replaced by a link to a host directory.
		symlinkSync(outside, sessions);
		await f.runtime.startFresh(channel);
		expect(readdirSync(outside)).toEqual(["owner-session.jsonl"]);
		// sessions/archive replaced by a link, with a real session file to archive.
		rmSync(sessions, { force: true });
		mkdirSync(sessions);
		writeFileSync(join(sessions, "guest.jsonl"), "guest\n");
		writeFileSync(join(sessions, "linked.jsonl"), "x");
		rmSync(join(sessions, "linked.jsonl"));
		symlinkSync(
			join(outside, "owner-session.jsonl"),
			join(sessions, "linked.jsonl"),
		);
		symlinkSync(outside, join(sessions, "archive"));
		await f.runtime.startFresh(channel);
		expect(readdirSync(outside)).toEqual(["owner-session.jsonl"]);
		const archive = join(sessions, "archive");
		expect(lstatSync(archive).isDirectory()).toBe(true);
		const [stamp] = readdirSync(archive);
		expect(readdirSync(join(archive, String(stamp)))).toEqual(["guest.jsonl"]);
		expect(existsSync(join(sessions, "linked.jsonl"))).toBe(true);
		// A symlinked attachments entry is replaced on the next start instead of failing forever.
		rmSync(join(workspace, "attachments"), { recursive: true, force: true });
		symlinkSync(outside, join(workspace, "attachments"));
		await f.runtime.start(channel, "profile");
		expect(lstatSync(join(workspace, "attachments")).isDirectory()).toBe(true);
		expect(readdirSync(outside)).toEqual(["owner-session.jsonl"]);
	} finally {
		rmSync(outside, { recursive: true, force: true });
		await f.close();
	}
});

test("Pi image isolates mounts, network and credentials, retaining only explicit operator metadata", () => {
	const body = piContainerCreateBody({
		name: "sandbox-test",
		image: "sandbox:test",
		channel: "discord:channel",
		profile: "profile",
		runDir: "/srv/channel/run",
		workspaceDir: "/srv/channel/workspace",
		uid: 1000,
		gid: 1000,
	}) as { Env: string[]; HostConfig: Record<string, unknown> };
	expect(body.HostConfig).toMatchObject({
		NetworkMode: "none",
		ReadonlyRootfs: true,
		CapDrop: ["ALL"],
		SecurityOpt: ["no-new-privileges"],
		Binds: [
			"/srv/channel/run:/run/sandbox:ro",
			"/srv/channel/workspace:/workspace",
		],
	});
	expect(body.Env.join("\n")).not.toContain("host-secret");
	expect(body.Env).toContain("CLAUDE_CODE_OAUTH_TOKEN=sandbox-dummy-token");
});
test("each turn's model call resolves the subscription token for its own speaker", async () => {
	const scopes: unknown[] = [];
	const seen: (string | null)[] = [];
	const f = fixture(false, {
		oauthToken: (scope) => {
			scopes.push(scope);
			return `token-${scope.speaker.id}`;
		},
		fetchImpl: async (_url, init) => {
			seen.push(new Headers(init.headers).get("authorization"));
			return Response.json({ content: "ok" });
		},
	});
	try {
		for (const id of ["a", "b"])
			expect(
				await f.runtime.runTurn({
					channel: "discord:123",
					profile: "profile",
					turnId: id,
					author: { id, name: `Guest ${id}` },
					text: "hello",
					images: [],
				}),
			).toMatchObject({ ok: true });
		expect(f.modelStatuses).toEqual([200, 200]);
		expect(seen).toEqual(["Bearer token-a", "Bearer token-b"]);
		expect(scopes).toEqual([
			{ channel: "discord:123", speaker: { id: "a", name: "Guest a" } },
			{ channel: "discord:123", speaker: { id: "b", name: "Guest b" } },
		]);
		expect(JSON.stringify(f.workerTurns)).not.toContain("token-");
	} finally {
		await f.close();
	}
});
