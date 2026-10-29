import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { workspaceFilesDir } from "./index.ts";
import { SandboxRuntime, type SandboxRuntimeOptions } from "./runtime.ts";
import {
	requiredProtocol,
	resolveSandboxRuntimeOptions,
} from "./runtime-options.ts";

const speaker = { id: "guest", name: "Guest", principalId: "p_guest" };
function options(
	root: string,
	extra: Partial<SandboxRuntimeOptions> = {},
): SandboxRuntimeOptions {
	return {
		image: "sandbox:fake",
		runRoot: join(root, "run"),
		workspaceRoot: join(root, "work"),
		model: "fake",
		modelUrl: "https://models.example/chat",
		apiKey: () => "k",
		driver: { run: async () => ({ ok: true, text: "done" }) },
		...extra,
	};
}

test("files true, an object and false resolve to limits, merged limits and none", async () => {
	const root = mkdtempSync("/tmp/sb-files-opt-");
	const seen: unknown[] = [];
	const driver = {
		run: async (_spec: unknown, turn: { files?: unknown }) => {
			seen.push(turn.files);
			return { ok: true, text: "done" };
		},
	};
	const runtimes = [
		undefined,
		false,
		true,
		{ maxFileBytes: 1000 },
		{ maxTotalBytes: 500_000 },
	].map((files) => new SandboxRuntime(options(root, { driver, files })));
	try {
		for (const [index, runtime] of runtimes.entries())
			await runtime.runTurn(`fake:c${index}`, speaker, "a");
		expect(seen).toEqual([
			undefined,
			undefined,
			{ maxFileBytes: 262_144, maxTotalBytes: 33_554_432 },
			{ maxFileBytes: 1000, maxTotalBytes: 33_554_432 },
			{ maxFileBytes: 262_144, maxTotalBytes: 500_000 },
		]);
	} finally {
		for (const runtime of runtimes) await runtime.dispose();
		rmSync(root, { recursive: true, force: true });
	}
});

test.each([
	[{ maxFileBytes: 0 }],
	[{ maxFileBytes: 1.5 }],
	[{ maxTotalBytes: -1 }],
	[{ maxFileBytes: 100, maxTotalBytes: 50 }],
	[{ maxFileBytes: 17 * 1024 * 1024 }],
	[{ maxTotalBytes: 2 ** 40 }],
])("files %p stops startup naming the option", (files) => {
	const root = mkdtempSync("/tmp/sb-files-opt-");
	try {
		expect(() =>
			resolveSandboxRuntimeOptions(options(root, { files })),
		).toThrow("files");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("files needs a protocol-2 image; false does not", () => {
	expect(
		requiredProtocol({ ...options("/x"), files: true })?.because,
	).toContain("files");
	expect(requiredProtocol({ ...options("/x"), files: false })).toBeUndefined();
	expect(requiredProtocol(options("/x"))).toBeUndefined();
});

test("an importer finds the files directory of a guild workspace", () => {
	expect(workspaceFilesDir("/srv/work/guild-x")).toBe(
		"/srv/work/guild-x/files",
	);
});
