import { expect, test } from "bun:test";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { DockerContainerDriver } from "./container-driver.ts";
import type { SandboxTurn } from "./protocol.ts";

const turn: SandboxTurn = {
	text: "test",
	speaker: { id: "guest", name: "Guest" },
	model: "fake",
	prompt: "test",
	timeZone: "UTC",
	tools: [],
	mcp: [],
};

for (const mode of ["ignore-term", "overflow", "stall-cleanup"]) {
	test(`driver bounds cleanup for an uncooperative CLI: ${mode}`, async () => {
		const root = mkdtempSync("/tmp/sb-lifecycle-");
		const binary = join(root, "fake-docker");
		const pids = join(root, "pids");
		const log = join(root, "calls");
		writeFileSync(
			binary,
			`#!/usr/bin/env bun\nimport {appendFileSync} from "node:fs";appendFileSync(${JSON.stringify(pids)},String(process.pid)+"\\n");appendFileSync(${JSON.stringify(log)},process.argv[2]+"\\n");process.on("SIGTERM",()=>{});if(process.argv[2]==="rm"){if(${JSON.stringify(mode)}==="stall-cleanup")setInterval(()=>{},1000);else process.exit(0);}else{await Bun.stdin.text();if(${JSON.stringify(mode)}==="stall-cleanup")process.stdout.write('{"ok":true,"text":"done"}');else{if(${JSON.stringify(mode)}==="overflow")process.stdout.write("x".repeat(3*1024*1024));setInterval(()=>{},1000);}}\n`,
		);
		chmodSync(binary, 0o700);
		mkdirSync(join(root, "run"));
		mkdirSync(join(root, "work"));
		try {
			const driver = new DockerContainerDriver(binary);
			const signal =
				mode === "ignore-term"
					? AbortSignal.timeout(1000)
					: new AbortController().signal;
			const started = Date.now();
			await expect(
				driver.run(
					{
						name: "sandbox-hostile",
						image: "sandbox:fake",
						runDir: join(root, "run"),
						workspaceDir: join(root, "work"),
						uid: 1000,
						gid: 1000,
					},
					turn,
					signal,
				),
			).rejects.toThrow();
			expect(Date.now() - started).toBeLessThan(8000);
			expect(readFileSync(log, "utf8")).toContain("rm");
			for (const pid of readFileSync(pids, "utf8")
				.trim()
				.split("\n")
				.map(Number))
				expect(() => process.kill(pid, 0)).toThrow();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}, 15_000);
}
