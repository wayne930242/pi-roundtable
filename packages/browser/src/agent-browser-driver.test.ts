import { afterEach, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginError } from "pi-roundtable";
import {
	agentBrowserDriver,
	browserContainerArgs,
	browserImageBuildCommand,
	DEFAULT_BROWSER_IMAGE,
} from "./agent-browser-driver.ts";
import { BrowserToolError, DEFAULT_BROWSER_LIMITS } from "./driver.ts";

const spec = {
	name: "pi-roundtable-browser-abc123",
	image: "pi-roundtable-browser:1",
	egressDir: "/tmp/prb-abc",
	uid: 1000,
	gid: 1000,
	memoryMb: 1024,
	cpus: 1.5,
	pids: 512,
	lifetimeSeconds: 420,
	maxOutputChars: 24_000,
	hostPid: 4242,
};

const pair = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

test("the container has no network, a read-only root, no capabilities, no privilege gain and a non-root user", () => {
	const args = browserContainerArgs(spec);
	expect(args.slice(0, 5)).toEqual([
		"run",
		"--detach",
		"--rm",
		"--init",
		"--pull",
	]);
	expect(pair(args, "--network")).toBe("none");
	expect(args).toContain("--read-only");
	expect(pair(args, "--cap-drop")).toBe("ALL");
	expect(pair(args, "--security-opt")).toBe("no-new-privileges:true");
	expect(pair(args, "--user")).toBe("1000:1000");
	expect(pair(args, "--memory")).toBe("1024m");
	expect(pair(args, "--pids-limit")).toBe("512");
	expect(args.at(-1)).toBe(spec.image);
	for (const unsafe of [
		"--privileged",
		"--network=host",
		"--publish",
		"-p",
		"--cap-add",
		"--device",
		"--volume",
		"-v",
		"--add-host",
	])
		expect(args).not.toContain(unsafe);
	expect(args.filter((arg) => arg === "--network")).toHaveLength(1);
});

test("the only mount is the egress folder, read-only, at /egress", () => {
	const args = browserContainerArgs(spec);
	const mounts = args.flatMap((arg, i) =>
		args[i - 1] === "--mount" ? [arg] : [],
	);
	expect(mounts).toEqual([
		"type=bind,src=/tmp/prb-abc,dst=/egress,readonly,bind-propagation=rprivate",
	]);
	expect(pair(args, "--tmpfs")).toStartWith("/tmp:");
});

test("the browser is pointed at the relay in the container, and nothing else", () => {
	const args = browserContainerArgs(spec);
	const env = Object.fromEntries(
		args.flatMap((arg, i) =>
			args[i - 1] === "--env"
				? [arg.split(/=(.*)/s).slice(0, 2) as [string, string]]
				: [],
		),
	);
	expect(env.HTTP_PROXY).toBe("http://127.0.0.1:3128");
	expect(env.HTTPS_PROXY).toBe("http://127.0.0.1:3128");
	expect(env.AGENT_BROWSER_PROXY).toBe("http://127.0.0.1:3128");
	expect(env.AGENT_BROWSER_ARGS).toContain(
		"--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
	);
	expect(env.BROWSER_LIFETIME_SECONDS).toBe("420");
	expect(env.AGENT_BROWSER_CONTENT_BOUNDARIES).toBe("1");
	expect(
		Object.keys(env).filter((key) => /KEY|TOKEN|SECRET|PASSWORD/i.test(key)),
	).toEqual([]);
});

test("a root user, a bad name or image, and a relative egress folder are refused", () => {
	expect(() => browserContainerArgs({ ...spec, uid: 0 })).toThrow(/non-root/);
	expect(() => browserContainerArgs({ ...spec, gid: 0 })).toThrow(PluginError);
	expect(() => browserContainerArgs({ ...spec, name: "Bad Name" })).toThrow(
		PluginError,
	);
	expect(() =>
		browserContainerArgs({ ...spec, image: "--privileged" }),
	).toThrow(PluginError);
	expect(() => browserContainerArgs({ ...spec, image: "a b" })).toThrow(
		PluginError,
	);
	expect(() =>
		browserContainerArgs({ ...spec, egressDir: "relative" }),
	).toThrow(PluginError);
	expect(() =>
		browserContainerArgs({ ...spec, egressDir: "/tmp/a,dst=/etc" }),
	).toThrow(PluginError);
});

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

/** A `docker` that logs its arguments and answers by script, so the driver runs without a daemon. */
function fakeDocker(script: string) {
	const dir = mkdtempSync(join(tmpdir(), "fake-docker-"));
	dirs.push(dir);
	const log = join(dir, "log");
	const binary = join(dir, "docker");
	writeFileSync(binary, `#!/bin/sh\necho "$*" >> "${log}"\n${script}\n`);
	chmodSync(binary, 0o755);
	return {
		binary,
		calls: () =>
			existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [],
	};
}

test("setup names the fix when Docker is missing, its daemon is down, or the image is not built", async () => {
	await expect(
		agentBrowserDriver({ binary: "/nonexistent/docker" }).check?.(),
	).rejects.toThrow(/needs Docker.*Install Docker and start its daemon/s);
	const down = fakeDocker(
		'echo "Cannot connect to the Docker daemon" >&2; exit 1',
	);
	await expect(
		agentBrowserDriver({ binary: down.binary }).check?.(),
	).rejects.toThrow(
		/the daemon did not answer \(Cannot connect to the Docker daemon\)/,
	);
	const noImage = fakeDocker(
		'case "$1" in image) echo "No such image" >&2; exit 1;; esac',
	);
	const error = await agentBrowserDriver({
		binary: noImage.binary,
		user: { uid: 1000, gid: 1000 },
	})
		.check?.()
		.then(
			() => undefined,
			(thrown: unknown) => thrown,
		);
	expect(error).toBeInstanceOf(PluginError);
	expect((error as Error).message).toContain(
		`the browser image ${DEFAULT_BROWSER_IMAGE} is not built`,
	);
	expect((error as Error).message).toContain(browserImageBuildCommand());
	expect(browserImageBuildCommand()).toMatch(
		/^docker build -t pi-roundtable-browser:\S+ -f \S+\/docker\/Dockerfile \S+\/docker$/,
	);
});

test("setup refuses a root user", async () => {
	const ok = fakeDocker("exit 0");
	await expect(
		agentBrowserDriver({
			binary: ok.binary,
			user: { uid: 0, gid: 0 },
		}).check?.(),
	).rejects.toThrow(/non-root/);
});

test("setup removes containers a dead host left, and keeps a live host's", async () => {
	const docker = fakeDocker(
		`case "$1" in ps) printf 'pi-roundtable-browser-dead 999999999\\npi-roundtable-browser-live ${process.pid}\\n';; esac`,
	);
	await agentBrowserDriver({
		binary: docker.binary,
		user: { uid: 1000, gid: 1000 },
	}).check?.();
	const calls = docker.calls();
	expect(calls).toContain("rm --force pi-roundtable-browser-dead");
	expect(
		calls.some(
			(call) =>
				call.includes("pi-roundtable-browser-live") && call.startsWith("rm"),
		),
	).toBe(false);
});

test("a task runs one container, runs commands in it with the argument list intact, and removes it with its proxy socket", async () => {
	const docker = fakeDocker(
		`case "$1" in
run) echo container-id;;
exec) case "$*" in
  *"skills get core"*) printf -- '---\\nname: core\\n---\\n# the guide body\\n';;
  *"open https://example.com"*) echo "opened";;
  *"cat /tmp/shots/1.png"*) printf 'PNGDATA';;
  *"fail-me"*) echo "boom" >&2; exit 1;;
esac;;
esac`,
	);
	const kept: number[] = [];
	const driver = agentBrowserDriver({
		binary: docker.binary,
		user: { uid: 1000, gid: 1000 },
	});
	const kit = await driver.start({
		signal: new AbortController().signal,
		limits: DEFAULT_BROWSER_LIMITS,
		keepScreenshot: (image) => kept.push(image.data.byteLength),
	});
	const [tool] = kit.tools;
	expect(kit.tools.map((item) => item.name)).toEqual(["agent_browser"]);
	expect(kit.skills?.[0]?.content).toBe("# the guide body\n");
	expect(kit.prompt).toContain("not a shell");
	const run = (input: object) =>
		tool?.execute(input as never, new AbortController().signal);

	expect((await run({ args: ["open", "https://example.com"] }))?.text).toBe(
		"opened",
	);
	// Refused before any docker call.
	const calls = docker.calls().length;
	await expect(run({ args: ["download", "@e1", "/tmp/x"] })).rejects.toThrow(
		BrowserToolError,
	);
	await expect(run({ args: ["screenshot", "/etc/passwd"] })).rejects.toThrow(
		/takes no path/,
	);
	expect(docker.calls().length).toBe(calls);
	// A failing command reaches the worker as an error with agent-browser's message.
	await expect(run({ args: ["click", "fail-me"] })).rejects.toThrow(
		/exited with 1: boom/,
	);
	const shot = await run({ args: ["screenshot", "--full"], keep: true });
	expect(shot?.images?.[0]?.data.byteLength).toBe(7);
	expect(shot?.text).toContain("kept for the reply (1 of at most 4)");
	expect(kept).toEqual([7]);

	const log = docker.calls();
	const started = log.find((call) => call.startsWith("run "));
	expect(started).toContain("--network none");
	const egress = /src=(\S+?),dst=\/egress/.exec(started ?? "")?.[1] ?? "";
	expect(existsSync(join(egress, "proxy.sock"))).toBe(true);
	expect(
		log.some(
			(call) =>
				call.includes("exec --workdir /tmp") &&
				call.includes("agent-browser screenshot --full /tmp/shots/1.png"),
		),
	).toBe(true);

	await kit.dispose();
	expect(log.filter((call) => call.startsWith("run "))).toHaveLength(1);
	expect(
		docker
			.calls()
			.some((call) =>
				/^rm --force pi-roundtable-browser-[0-9a-f]{12}$/.test(call),
			),
	).toBe(true);
	expect(existsSync(egress)).toBe(false);
});

test("commands run one at a time, in the order they were called", async () => {
	const dir = mkdtempSync(join(tmpdir(), "fake-docker-order-"));
	dirs.push(dir);
	const events = join(dir, "events");
	const docker = fakeDocker(
		`case "$1" in
run) echo id;;
exec) case "$*" in
  *"skills get core"*) echo guide;;
  *"get text one"*) echo start-one >> "${events}"; sleep 0.3; echo end-one >> "${events}"; echo one;;
  *"get text two"*) echo start-two >> "${events}"; echo end-two >> "${events}"; echo two;;
esac;;
esac`,
	);
	const kit = await agentBrowserDriver({
		binary: docker.binary,
		user: { uid: 1000, gid: 1000 },
	}).start({
		signal: new AbortController().signal,
		limits: DEFAULT_BROWSER_LIMITS,
		keepScreenshot: () => 1,
	});
	try {
		const tool = kit.tools[0];
		const signal = new AbortController().signal;
		await Promise.all([
			tool?.execute({ args: ["get", "text", "one"] } as never, signal),
			tool?.execute({ args: ["get", "text", "two"] } as never, signal),
		]);
		expect(readFileSync(events, "utf8").trim().split("\n")).toEqual([
			"start-one",
			"end-one",
			"start-two",
			"end-two",
		]);
	} finally {
		await kit.dispose();
	}
});

test("a start that fails removes what it made, and says how to build a missing image", async () => {
	const docker = fakeDocker(
		`case "$1" in run) echo "Unable to find image 'x' locally" >&2; exit 125;; esac`,
	);
	await expect(
		agentBrowserDriver({
			binary: docker.binary,
			user: { uid: 1000, gid: 1000 },
		}).start({
			signal: new AbortController().signal,
			limits: DEFAULT_BROWSER_LIMITS,
			keepScreenshot: () => 1,
		}),
	).rejects.toThrow(
		/did not start \(Unable to find image.*build it with: docker build/s,
	);
	expect(
		docker
			.calls()
			.some((call) => call.startsWith("rm --force pi-roundtable-browser-")),
	).toBe(true);
});

test("cancelling during a command kills the Docker client at once and rejects with the reason", async () => {
	const docker = fakeDocker(
		`case "$1" in
run) echo id;;
exec) case "$*" in *"skills get core"*) echo guide;; *"wait 20000"*) sleep 30;; esac;;
esac`,
	);
	const controller = new AbortController();
	const kit = await agentBrowserDriver({
		binary: docker.binary,
		user: { uid: 1000, gid: 1000 },
	}).start({
		signal: controller.signal,
		limits: DEFAULT_BROWSER_LIMITS,
		keepScreenshot: () => 1,
	});
	const started = Date.now();
	const running = kit.tools[0]?.execute(
		{ args: ["wait", "20000"] } as never,
		controller.signal,
	);
	setTimeout(() => controller.abort(new Error("turn cancelled")), 200);
	await expect(running).rejects.toThrow("turn cancelled");
	expect(Date.now() - started).toBeLessThan(5000);
	await kit.dispose();
	expect(docker.calls().some((call) => call.startsWith("rm --force"))).toBe(
		true,
	);
});
