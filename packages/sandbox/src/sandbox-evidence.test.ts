import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordingLogger } from "pi-roundtable/testing";
import { PiSandboxBroker } from "./pi-broker.ts";
import {
	demuxDockerLog,
	type PiContainerDriver,
	type PiContainerSpec,
	PiDockerContainerDriver,
	piContainerCreateBody,
} from "./pi-container-driver.ts";
import { PiSandboxRuntime, type PiSandboxTurn } from "./pi-runtime.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** A runtime whose fake worker answers each turn with `reply`, or never when it is undefined. */
function runtimeWith(reply: unknown, logs = "worker line 1\nworker line 2\n") {
	const root = realpathSync(mkdtempSync("/tmp/pi-evd-"));
	const recorder = recordingLogger();
	const calls: string[] = [];
	const stop = new AbortController();
	const driver: PiContainerDriver = {
		status: async () => ({ state: "running" }),
		remove: async () => {
			calls.push("remove");
			stop.abort();
		},
		logs: async (_name, lines) => {
			calls.push(`logs:${lines}`);
			return logs;
		},
		ensureRunning: async (spec: PiContainerSpec) => {
			const unix = join(spec.runDir, "broker.sock");
			await (
				await fetch("http://broker/worker/ready", { unix, method: "POST" })
			).body?.cancel();
			void (async () => {
				const next = await fetch("http://broker/worker/next", {
					unix,
					signal: stop.signal,
				});
				const turn = (await next.json()) as { turnId: string };
				if (reply === undefined) return;
				await (
					await fetch("http://broker/worker/result", {
						unix,
						method: "POST",
						body: JSON.stringify({ turnId: turn.turnId, result: reply }),
					})
				).body?.cancel();
			})().catch(() => {});
		},
	};
	const runtime = new PiSandboxRuntime({
		partyDir: root,
		image: "sandbox:test",
		driver,
		profiles: { profile: { model: "host-model" } },
		oauthToken: () => "host-secret",
		memory: { promptBlock: async () => "" },
		effort: { judge: async () => "low" },
		logger: recorder.logger,
		turnTimeoutMs: 1000,
	});
	cleanups.push(async () => {
		stop.abort();
		await runtime.stopBrokers();
		rmSync(root, { recursive: true, force: true });
	});
	const turn: PiSandboxTurn = {
		channel: "discord:party",
		profile: "profile",
		turnId: "t1",
		author: { id: "guest", name: "Guest" },
		text: "hi",
		images: [],
	};
	return { runtime, turn, lines: recorder.lines, calls };
}

test("a failed turn keeps the worker's reason as its message and cause, and logs it", async () => {
	const { runtime, turn, lines, calls } = runtimeWith({
		ok: false,
		error: "prompt failed: 529 overloaded",
	});
	const result = await runtime.runTurn(turn);
	expect(result.ok).toBe(false);
	if (result.ok) return;
	expect(result.error.message).toContain("prompt failed: 529 overloaded");
	expect(result.error.cause).toBeInstanceOf(Error);
	expect(
		lines.find((l) => l.message === "sandbox turn failed")?.fields,
	).toMatchObject({
		channel: "discord:party",
		turnId: "t1",
		timedOut: false,
		message: expect.stringContaining("529 overloaded"),
	});
	// A worker that answered is not removed, so its log is not read.
	expect(calls).toEqual([]);
});

test("a timed-out turn reads the worker's last log lines before the container is removed", async () => {
	const { runtime, turn, lines, calls } = runtimeWith(undefined);
	const result = await runtime.runTurn(turn);
	expect(result.ok).toBe(false);
	if (result.ok) return;
	expect(result.error.message).toBe("Sandbox turn timed out");
	expect(result.error.cause).toBeDefined();
	expect(calls).toEqual(["logs:200", "remove"]);
	expect(
		lines.find((l) => l.message === "sandbox turn failed")?.fields,
	).toMatchObject({ timedOut: true, cancelled: false });
	expect(
		lines.find((l) => l.message === "sandbox worker log before removal")
			?.fields,
	).toMatchObject({
		channel: "discord:party",
		turnId: "t1",
		lines: "worker line 1\nworker line 2",
	});
});

function boundBroker(
	fetchImpl: (url: string, init: RequestInit) => Promise<Response>,
) {
	const recorder = recordingLogger();
	const broker = new PiSandboxBroker({
		model: "host-model",
		oauthToken: () => "host-secret",
		fetchImpl,
		logger: recorder.logger,
	});
	broker.bind({
		channel: "discord:party",
		profile: "profile",
		speaker: { id: "guest", name: "Guest" },
		thinking: "low",
		signal: new AbortController().signal,
	});
	const call = () =>
		broker.handle(
			new Request("http://broker/anthropic/v1/messages", {
				method: "POST",
				body: JSON.stringify({
					model: "x",
					messages: [{ role: "user", content: "hi" }],
					max_tokens: 2000,
				}),
			}),
		);
	return { call, lines: recorder.lines };
}

test("an upstream error is logged with channel, status, latency and its body, without the credential", async () => {
	const { call, lines } = boundBroker(
		async () =>
			new Response(
				`{"error":"overloaded","echo":"Bearer host-secret","encoded":"${Buffer.from("host-secret").toString("base64")}"}`,
				{
					status: 529,
				},
			),
	);
	const response = await call();
	expect(response.status).toBe(529);
	// The body echoes the credential, so the worker's copy is refused; the log still has its head.
	await response.text().catch(() => "");
	await Bun.sleep(20);
	const failure = lines.find(
		(l) => l.message === "sandbox upstream call failed" && "body" in l.fields,
	);
	expect(failure?.fields).toMatchObject({
		channel: "discord:party",
		upstream: "model",
		status: 529,
		latencyMs: expect.any(Number),
		body: expect.stringContaining("overloaded"),
	});
	expect(JSON.stringify(failure)).not.toContain("host-secret");
	expect(JSON.stringify(failure)).not.toContain(
		Buffer.from("host-secret").toString("base64"),
	);
});

test("an upstream error body over the log's share still reaches the worker whole, with its status", async () => {
	const big = `{"error":"${"x".repeat(2 * 1024 * 1024)}"}`;
	const { call, lines } = boundBroker(
		async () => new Response(big, { status: 413 }),
	);
	const response = await call();
	expect(response.status).toBe(413);
	expect((await response.text()).length).toBe(big.length);
	await Bun.sleep(20);
	expect(
		lines.find((l) => l.message === "sandbox upstream call failed")?.fields,
	).toMatchObject({ status: 413 });
});

test("an upstream call that throws is logged before the worker gets its 502", async () => {
	const { call, lines } = boundBroker(async () => {
		throw new Error("socket hang up", { cause: new Error("ECONNRESET") });
	});
	const response = await call();
	expect(response.status).toBe(502);
	expect(
		lines.find((l) => l.message === "sandbox upstream call failed")?.fields,
	).toMatchObject({
		channel: "discord:party",
		upstream: "model",
		error: "Error: socket hang up (cause: Error: ECONNRESET)",
	});
});

const spec: PiContainerSpec = {
	name: "sandbox-party",
	image: "sandbox:test",
	channel: "discord:party",
	profile: "profile",
	runDir: "/srv/run",
	workspaceDir: "/srv/workspace",
	uid: 1000,
	gid: 1000,
};

test("containers log to journald tagged with their channel unless the driver names another", async () => {
	expect(
		(piContainerCreateBody(spec) as { HostConfig: { LogConfig: unknown } })
			.HostConfig.LogConfig,
	).toEqual({ Type: "journald", Config: { tag: "sandbox/discord:party" } });
	expect(() =>
		piContainerCreateBody({ ...spec, log: { driver: "-bad" } }),
	).toThrow("log driver");

	const dir = mkdtempSync(join(tmpdir(), "docker-"));
	const socket = join(dir, "docker.sock");
	const created: unknown[] = [];
	const server = Bun.serve({
		unix: socket,
		async fetch(request) {
			const url = new URL(request.url);
			if (url.pathname.endsWith("/json"))
				return new Response("missing", { status: 404 });
			if (url.pathname === "/containers/create")
				created.push(await request.json());
			return new Response("{}", { status: 201 });
		},
	});
	cleanups.push(() => {
		server.stop(true);
		rmSync(dir, { recursive: true, force: true });
	});
	const driver = new PiDockerContainerDriver(socket, undefined, {
		log: { driver: "local", options: { "max-size": "10m" } },
	});
	await driver.ensureRunning(spec);
	expect(
		(created[0] as { HostConfig: { LogConfig: unknown } }).HostConfig.LogConfig,
	).toEqual({ Type: "local", Config: { "max-size": "10m" } });
});

test("docker's framed log stream is read back as text", () => {
	const frame = (stream: number, text: string) => {
		const body = new TextEncoder().encode(text);
		const head = new Uint8Array(8);
		head[0] = stream;
		new DataView(head.buffer).setUint32(4, body.length);
		return [...head, ...body];
	};
	expect(
		demuxDockerLog(
			new Uint8Array([...frame(1, "out line\n"), ...frame(2, "err line\n")]),
		),
	).toBe("out line\nerr line\n");
	expect(demuxDockerLog(new TextEncoder().encode("plain tty text"))).toBe(
		"plain tty text",
	);
});
