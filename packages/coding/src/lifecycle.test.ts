import { afterEach, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CodingJob } from "./coding-desk.ts";
import { PiCodingWorker } from "./pi-coding-worker.ts";
import { CodingWorkerFailure } from "./worker-failure.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});
function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "coding-process-"));
	dirs.push(dir);
	const repoDir = join(dir, "repo");
	const agentDir = join(dir, "login");
	mkdirSync(repoDir);
	mkdirSync(agentDir);
	const worker = new PiCodingWorker({
		agentDir,
		packages: [
			fileURLToPath(new URL("./testing/faux-provider.ts", import.meta.url)),
		],
	});
	const job: CodingJob & { dir: string } = {
		id: 1,
		repo: "sample/project",
		task: "Check the process",
		channel: "test:room",
		model: "faux/worker",
		thinking: "off",
		skillFiles: [],
		startedAt: new Date(),
		startHead: "",
		dir: repoDir,
	};
	return { worker, job, repoDir, agentDir };
}
function running(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

test("aborting a real worker during its approval card kills the child process", async () => {
	const { worker, job, repoDir } = fixture();
	const controller = new AbortController();
	let started = () => {};
	const waiting = new Promise<void>((resolve) => {
		started = resolve;
	});
	const result = worker.run(job, controller.signal, async () => {
		started();
		return new Promise(() => {});
	});
	await waiting;
	const pid = Number(readFileSync(join(repoDir, "worker.pid"), "utf8"));
	expect(running(pid)).toBe(true);
	controller.abort();
	await expect(result).rejects.toThrow("stopped");
	expect(running(pid)).toBe(false);
});

test("normal worker completion cleans up shell descendants in its process group", async () => {
	const { worker, job, repoDir } = fixture();
	writeFileSync(join(repoDir, "start-descendant"), "start");
	await worker.run(job, AbortSignal.timeout(10_000), async () => "held");
	const pid = Number(readFileSync(join(repoDir, "descendant.pid"), "utf8"));
	await Bun.sleep(50); // Allow the OS to reap the terminated orphan.
	expect(running(pid)).toBe(false);
});

test("worker configuration failures return a credential-free exit category", async () => {
	const { worker, job, repoDir } = fixture();
	let failure: unknown;
	try {
		await worker.run(
			{ ...job, model: "faux/missing" },
			AbortSignal.timeout(10_000),
			async () => "held",
		);
	} catch (error) {
		failure = error;
	}
	expect(failure).toBeInstanceOf(CodingWorkerFailure);
	if (failure instanceof CodingWorkerFailure) {
		expect(failure.category).toBe("exit");
		expect(failure.exitCode).toBe(1);
		expect(failure.message).not.toContain("auth.json");
	}
	const pid = Number(readFileSync(join(repoDir, "worker.pid"), "utf8"));
	expect(running(pid)).toBe(false);
});

test("worker standing context includes regular repo instructions, not parent or symlinked instructions", async () => {
	const { worker, job, repoDir } = fixture();
	const outside = join(repoDir, "..", "AGENTS.md");
	const inside = join(repoDir, "AGENTS.md");
	writeFileSync(outside, "EXTERNAL_CONTEXT_CANARY");
	symlinkSync(outside, inside);
	const first = await worker.run(
		job,
		AbortSignal.timeout(10_000),
		async () => "held",
	);
	expect(first).toContain("externalContext=false");
	rmSync(inside);
	writeFileSync(inside, "REPO_CONTEXT_CANARY");
	const second = await worker.run(
		job,
		AbortSignal.timeout(10_000),
		async () => "held",
	);
	expect(second).toContain("externalContext=false");
	expect(second).toContain("repoContext=true");
});

test("trusted host prompt and workspace carry into the process without bypassing private hold policy", async () => {
	const { job, repoDir, agentDir } = fixture();
	const workspace = realpathSync(join(repoDir, ".."));
	const seen: string[] = [];
	let reviewed = 0;
	const worker = new PiCodingWorker({
		agentDir,
		workspace,
		prompt: () => "HOST_PROMPT_CANARY: carry the host's approved contract.",
		packages: [
			fileURLToPath(new URL("./testing/faux-provider.ts", import.meta.url)),
		],
		holds: (tool, _input, scope) => {
			seen.push(`${tool}: ${scope.workspace}`);
			return "Host private action";
		},
	});
	const report = await worker.run(
		{
			...job,
			thread: {
				id: "progress",
				channel: "test:thread",
				mention: "#progress",
				post: async () => {
					throw new Error("Host thread handles must stay in the parent");
				},
				close: async () => {
					throw new Error("Host thread handles must stay in the parent");
				},
			},
		},
		AbortSignal.timeout(10_000),
		async (call) => {
			reviewed++;
			expect(call.action).toBe("Host private action");
			return "held";
		},
	);
	expect(seen).toEqual([`write: ${workspace}`]);
	expect(reviewed).toBe(1);
	expect(report).toContain("hostPrompt=true");
	expect(report).toContain("Do not retry");
	const pid = Number(readFileSync(join(repoDir, "worker.pid"), "utf8"));
	expect(running(pid)).toBe(false);
});
