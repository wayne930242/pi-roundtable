import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { SandboxResearchWorker } from "./research-worker.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

test("needs tools, or search with a fetch", () => {
	const base = {
		modelRuntime: {} as ModelRuntime,
		agentDir: "/tmp/x",
		workDir: "/tmp/y",
		model: "faux/worker",
		thinking: "low" as const,
	};
	expect(() => new SandboxResearchWorker(base)).toThrow();
	expect(
		() => new SandboxResearchWorker({ ...base, fetchContent: async () => "" }),
	).toThrow("search");
	expect(
		() =>
			new SandboxResearchWorker({
				...base,
				tools: { toolNames: ["fetch_content"] },
			}),
	).not.toThrow();
});

test("a host's own tools replace the built-in two, only the named ones are active, and the scope wraps the run", async () => {
	const dir = mkdtempSync(join(tmpdir(), "research-tools-"));
	dirs.push(dir);
	const agentDir = join(dir, "login");
	const workDir = join(dir, "work");
	mkdirSync(agentDir);
	mkdirSync(workDir);
	const modelRuntime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: join(agentDir, "models.json"),
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	const scoped: string[] = [];
	const worker = new SandboxResearchWorker({
		modelRuntime,
		agentDir,
		workDir,
		model: "faux/worker",
		thinking: "low",
		tools: {
			extensionPaths: [
				fileURLToPath(new URL("./testing/faux-research.ts", import.meta.url)),
			],
			toolNames: ["web_search", "fetch_content", "get_search_content"],
			prompt: "LEGACY_PROMPT",
		},
		scope: async (run) => {
			scoped.push("in");
			try {
				return await run();
			} finally {
				scoped.push("out");
			}
		},
	});
	const report = await worker.run("Look it up", AbortSignal.timeout(20_000));
	expect(scoped).toEqual(["in", "out"]);
	expect(report).toContain("HOST fetch_content ran");
	// The tool the host did not name is not active, so the model's call to it fails.
	expect(report).not.toContain("HOST host_secret_tool");
	expect(report).toContain("Tool host_secret_tool not found");
});
