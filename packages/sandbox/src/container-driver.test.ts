import { expect, test } from "bun:test";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
	type ContainerSpec,
	containerRunArgs,
	DockerContainerDriver,
} from "./container-driver.ts";
import type { SandboxTurn } from "./protocol.ts";

test("driver consumes bounded stdout and removes its exact named container after a normal turn", async () => {
	const root = mkdtempSync("/tmp/sb-driver-");
	const log = join(root, "calls.jsonl");
	const binary = join(root, "fake-docker");
	const turn: SandboxTurn = {
		text: "hello",
		speaker: { id: "guest", name: "Guest" },
		model: "fake",
		prompt: "test",
		timeZone: "UTC",
		tools: [],
		mcp: [],
	};
	writeFileSync(
		binary,
		`#!/usr/bin/env bun\nimport {appendFileSync} from "node:fs"; appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2))+"\\n"); if (process.argv[2] === "run") { await Bun.stdin.text(); process.stdout.write(JSON.stringify({ok:true,text:"done"})); }\n`,
	);
	chmodSync(binary, 0o700);
	mkdirSync(join(root, "run"));
	mkdirSync(join(root, "work"));
	try {
		const driver = new DockerContainerDriver(binary);
		expect(
			await driver.run(
				{
					name: "sandbox-one",
					image: "sandbox:fake",
					runDir: join(root, "run"),
					workspaceDir: join(root, "work"),
					uid: 1000,
					gid: 1000,
				},
				turn,
				new AbortController().signal,
			),
		).toEqual({ ok: true, text: "done" });
		const lines = readFileSync(log, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(lines[0][0]).toBe("run");
		expect(lines[1]).toEqual(["rm", "--force", "sandbox-one"]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

const spec: ContainerSpec = {
	name: "roundtable-sandbox-test",
	image: "sandbox:local",
	runDir: "/srv/sandbox/run/turn-a",
	workspaceDir: "/srv/sandbox/work/channel-a",
	uid: 1000,
	gid: 1000,
};
test("run arguments seal network, rootfs, privileges, mounts, user and resources", () => {
	const args = containerRunArgs(spec);
	const value = (flag: string) => args[args.indexOf(flag) + 1];
	expect(value("--network")).toBe("none");
	expect(args).toContain("--sig-proxy=false");
	expect(value("--log-driver")).toBe("none");
	expect(value("--pull")).toBe("never");
	expect(args).toContain("--read-only");
	expect(value("--cap-drop")).toBe("ALL");
	expect(value("--security-opt")).toBe("no-new-privileges:true");
	expect(value("--user")).toBe("1000:1000");
	expect(value("--memory")).toBe("512m");
	expect(value("--memory-swap")).toBe("512m");
	expect(value("--cpus")).toBe("1");
	expect(value("--pids-limit")).toBe("64");
	expect(value("--tmpfs")).toContain("noexec,nosuid,nodev");
	expect(args.filter((arg) => arg.startsWith("type=bind,"))).toEqual([
		"type=bind,src=/srv/sandbox/run/turn-a,dst=/broker,readonly,bind-propagation=rprivate",
		"type=bind,src=/srv/sandbox/work/channel-a,dst=/workspace,bind-propagation=rprivate",
	]);
	expect(args.join(" ")).not.toContain("docker.sock");
	expect(args.join(" ")).not.toContain("--privileged");
	expect(args.join(" ")).not.toContain("--env-file");
	expect(args.at(-1)).toBe("sandbox:local");
});
test("operator resource overrides are honored", () => {
	const args = containerRunArgs({
		...spec,
		memoryMb: 768,
		cpus: 0.5,
		pids: 32,
	});
	expect(args).toContain("768m");
	expect(args).toContain("0.5");
	expect(args).toContain("32");
});
for (const override of [
	{ uid: 0 },
	{ gid: 0 },
	{ runDir: "/" },
	{ runDir: "relative" },
	{ runDir: "/srv/evil,dst=/host" },
	{ runDir: spec.workspaceDir },
	{ runDir: `${spec.workspaceDir}/run` },
	{ image: "--privileged" },
	{ memoryMb: -1 },
	{ cpus: 0 },
	{ pids: NaN },
]) {
	test(`refuses unsafe container options ${JSON.stringify(override)}`, () =>
		expect(() => containerRunArgs({ ...spec, ...override })).toThrow());
}

test("a channel directory adds a third read-write mount at /channel, and only then", () => {
	const args = containerRunArgs({
		...spec,
		workspaceDir: "/srv/sandbox/work/guild-a",
		channelDir: "/srv/sandbox/work/state-a",
	});
	expect(args.filter((arg) => arg.startsWith("type=bind,"))).toEqual([
		"type=bind,src=/srv/sandbox/run/turn-a,dst=/broker,readonly,bind-propagation=rprivate",
		"type=bind,src=/srv/sandbox/work/guild-a,dst=/workspace,bind-propagation=rprivate",
		"type=bind,src=/srv/sandbox/work/state-a,dst=/channel,bind-propagation=rprivate",
	]);
	expect(
		containerRunArgs(spec).filter((arg) => arg.startsWith("type=bind,")),
	).toHaveLength(2);
});

for (const override of [
	{ channelDir: spec.runDir },
	{ channelDir: spec.workspaceDir },
	{ channelDir: `${spec.workspaceDir}/state` },
	{ channelDir: "/srv/sandbox" },
	{ channelDir: "/" },
	{ channelDir: "relative" },
	{ channelDir: "/srv/sandbox/state,dst=/host" },
	{ channelDir: `${spec.runDir}/channel` },
]) {
	test(`refuses an unsafe channel directory ${JSON.stringify(override)}`, () =>
		expect(() => containerRunArgs({ ...spec, ...override })).toThrow());
}

test("the Docker driver resolves the channel directory like the others and reads an image's protocol label", async () => {
	const root = mkdtempSync("/tmp/sb-driver-");
	const log = join(root, "calls.jsonl");
	const binary = join(root, "fake-docker");
	writeFileSync(
		binary,
		`#!/usr/bin/env bun\nimport {appendFileSync} from "node:fs"; appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2))+"\\n"); if (process.argv[2] === "image") { const image = process.argv.at(-1); if (image === "missing:1") { process.stderr.write("No such image"); process.exit(1); } process.stdout.write(image === "labelled:1" ? "2\\n" : image === "odd:1" ? "two\\n" : "<no value>\\n"); } else if (process.argv[2] === "run") { await Bun.stdin.text(); process.stdout.write(JSON.stringify({ok:true,text:"done"})); }\n`,
	);
	chmodSync(binary, 0o700);
	for (const name of ["run", "work", "state"]) mkdirSync(join(root, name));
	try {
		const driver = new DockerContainerDriver(binary);
		expect(await driver.imageProtocol("labelled:1")).toBe(2);
		expect(await driver.imageProtocol("old:1")).toBeUndefined();
		expect(await driver.imageProtocol("odd:1")).toBeUndefined();
		await expect(driver.imageProtocol("missing:1")).rejects.toThrow(
			"missing:1",
		);
		const inspect = JSON.parse(readFileSync(log, "utf8").split("\n")[0] ?? "");
		expect(inspect.slice(0, 2)).toEqual(["image", "inspect"]);
		expect(inspect.join(" ")).toContain("pi-roundtable-sandbox.protocol");
		await driver.run(
			{
				name: "sandbox-three",
				image: "sandbox:fake",
				runDir: join(root, "run"),
				workspaceDir: join(root, "work"),
				channelDir: join(root, "state"),
				uid: 1000,
				gid: 1000,
			},
			{
				text: "hi",
				speaker: { id: "g", name: "G" },
				model: "fake",
				prompt: "p",
				timeZone: "UTC",
				tools: [],
				mcp: [],
			},
			new AbortController().signal,
		);
		const run = readFileSync(log, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line))
			.find((line) => line[0] === "run");
		expect(run.join(" ")).toContain(
			`src=${realpathSync(join(root, "state"))},dst=/channel`,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
