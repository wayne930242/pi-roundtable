import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ReplyFile } from "../domain/conversation.ts";
import { REPLY_FILE_LIMITS, withReplyFiles } from "../reply-files.ts";
import { attachFileExtension } from "./attach-file-tool.ts";

let root = "";
let roots: { workspace: string; scratchDir: string };

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "attach-file-"));
	roots = { workspace: join(root, "work"), scratchDir: join(root, "scratch") };
	mkdirSync(roots.workspace);
	mkdirSync(roots.scratchDir);
	writeFileSync(join(roots.scratchDir, "sigil.png"), "PNGDATA");
	writeFileSync(join(root, "secret.txt"), "secret");
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

type Result = { content: { text: string }[]; isError?: boolean };

function attachFile(): (params: Record<string, unknown>) => Promise<Result> {
	let execute: ((id: string, params: unknown) => Promise<Result>) | undefined;
	attachFileExtension(roots)({
		registerTool: (definition: { execute: typeof execute }) => {
			execute = definition.execute;
		},
	} as unknown as ExtensionAPI);
	return (params) => {
		if (!execute) throw new Error("attach_file did not register");
		return execute("call", params);
	};
}

/** Runs one call inside a turn and returns its result with the files the turn carried. */
async function inTurn(
	params: Record<string, unknown>,
	supported = true,
): Promise<{ result: Result; files: ReplyFile[] }> {
	const run = attachFile();
	let result: Result | undefined;
	const turn = await withReplyFiles(supported, async () => {
		result = await run(params);
		return { ok: true, text: "done" };
	});
	if (!turn.ok || !result) throw new Error("the turn failed");
	return { result, files: turn.files ?? [] };
}

test("attach_file queues a scratch file for the reply and says so", async () => {
	const { result, files } = await inTurn({
		path: join(roots.scratchDir, "sigil.png"),
	});
	expect(result.isError).toBeFalsy();
	expect(result.content[0]?.text).toMatch(
		/sigil\.png .*will appear with your reply/,
	);
	expect(files).toEqual([
		{ name: "sigil.png", data: new Uint8Array(Buffer.from("PNGDATA")) },
	]);
	const renamed = await inTurn({
		path: join(roots.scratchDir, "sigil.png"),
		filename: "mark.png",
	});
	expect(renamed.files[0]?.name).toBe("mark.png");
});

test("attach_file refuses a path outside the workspace and the scratch dir", async () => {
	const { result, files } = await inTurn({ path: join(root, "secret.txt") });
	expect(result.isError).toBe(true);
	expect(result.content[0]?.text).toMatch(/outside the workspace/);
	expect(files).toEqual([]);
});

test("attach_file refuses on a surface without reply files", async () => {
	const { result, files } = await inTurn(
		{ path: join(roots.scratchDir, "sigil.png") },
		false,
	);
	expect(result.isError).toBe(true);
	expect(result.content[0]?.text).toMatch(/does not support reply files/);
	expect(files).toEqual([]);
});

test("attach_file holds to REPLY_FILE_LIMITS", async () => {
	const big = join(roots.scratchDir, "big.bin");
	writeFileSync(big, new Uint8Array(REPLY_FILE_LIMITS.maxFileBytes + 1));
	const tooBig = await inTurn({ path: big });
	expect(tooBig.result.isError).toBe(true);
	expect(tooBig.result.content[0]?.text).toMatch(/at most 10485760 bytes/);
	expect(tooBig.files).toEqual([]);

	const run = attachFile();
	const results: Result[] = [];
	await withReplyFiles(true, async () => {
		for (let i = 0; i <= REPLY_FILE_LIMITS.maxFiles; i++)
			results.push(await run({ path: join(roots.scratchDir, "sigil.png") }));
		return { ok: true, text: "done" };
	});
	expect(results.filter((r) => r.isError)).toHaveLength(1);
	expect(results.at(-1)?.content[0]?.text).toMatch(/at most 10 reply files/);
});
