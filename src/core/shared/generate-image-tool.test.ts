import { afterAll, beforeAll, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	truncateSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ImageDrawer, ReferenceImage } from "../contract/providers.ts";
import type { ReplyFile } from "../domain/conversation.ts";
import { withReplyFiles } from "../reply-files.ts";
import { sessionExtensions } from "../runtime/runtime-types.ts";
import { imageTools } from "../runtime/session-factory.ts";
import { CORE_TOOL_TIERS, toolTiers } from "../tool-tiers.ts";
import {
	GENERATE_IMAGE_TOOL,
	generateImageExtension,
	REFERENCE_IMAGE_LIMITS,
} from "./generate-image-tool.ts";

const PNG = new Uint8Array([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3,
]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 9]);

let root = "";
let roots: { workspace: string; scratchDir: string };

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "generate-image-"));
	roots = { workspace: join(root, "work"), scratchDir: join(root, "scratch") };
	mkdirSync(roots.workspace);
	mkdirSync(roots.scratchDir);
	writeFileSync(join(roots.workspace, "lotus.jpg"), JPEG);
	writeFileSync(join(roots.scratchDir, "notes.txt"), "not a picture");
	mkdirSync(join(roots.scratchDir, "folder"));
	writeFileSync(join(root, "outside.png"), PNG);
	symlinkSync(join(root, "outside.png"), join(roots.scratchDir, "link.png"));
	writeFileSync(join(roots.scratchDir, "huge.png"), PNG);
	truncateSync(
		join(roots.scratchDir, "huge.png"),
		REFERENCE_IMAGE_LIMITS.maxImageBytes + 1,
	);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

type Result = { content: { text: string }[]; isError?: boolean };
type Call = { prompt: string; references: readonly ReferenceImage[] };

function tool(draw: ImageDrawer) {
	let execute:
		| ((id: string, params: unknown, signal?: AbortSignal) => Promise<Result>)
		| undefined;
	generateImageExtension(
		draw,
		roots,
	)({
		registerTool: (definition: { execute: typeof execute }) => {
			execute = definition.execute;
		},
	} as unknown as ExtensionAPI);
	return (params: Record<string, unknown>) => {
		if (!execute) throw new Error("generate_image did not register");
		return execute("call", params, new AbortController().signal);
	};
}

async function inTurn(
	draw: ImageDrawer,
	params: Record<string, unknown>,
	supported = true,
): Promise<{ result: Result; files: ReplyFile[] }> {
	const run = tool(draw);
	let result: Result | undefined;
	const turn = await withReplyFiles(supported, async () => {
		result = await run(params);
		return { ok: true, text: "done" };
	});
	if (!turn.ok || !result) throw new Error("the turn failed");
	return { result, files: turn.files ?? [] };
}

function drawer(calls: Call[], output = PNG): ImageDrawer {
	return async (prompt, references) => {
		calls.push({ prompt, references });
		return output;
	};
}

const drawings = () => join(roots.scratchDir, "drawings");
const saved = () => (existsSync(drawings()) ? readdirSync(drawings()) : []);

test("generate_image draws, saves under the scratch dir's drawings, attaches it, and names the path", async () => {
	const calls: Call[] = [];
	const { result, files } = await inTurn(drawer(calls), {
		prompt: "A painted Guanyin on a lotus seat, no text",
		reference_paths: ["lotus.jpg"],
	});
	expect(result.isError).toBeFalsy();
	expect(calls).toEqual([
		{
			prompt: "A painted Guanyin on a lotus seat, no text",
			references: [
				{ data: Buffer.from(JPEG).toString("base64"), mimeType: "image/jpeg" },
			],
		},
	]);
	const [name] = files.map((file) => file.name);
	expect(name).toMatch(/^generated-.*\.png$/);
	expect(files[0]?.data).toEqual(PNG);
	const path = join(drawings(), name ?? "");
	expect(new Uint8Array(readFileSync(path))).toEqual(PNG);
	expect(result.content[0]?.text).toContain(path);
	expect(result.content[0]?.text).not.toContain("base64");
});

test("a picture that cannot be attached is kept and the result says so", async () => {
	const { result, files } = await inTurn(
		drawer([]),
		{ prompt: "a lotus" },
		false,
	);
	expect(result.isError).toBeFalsy();
	expect(files).toEqual([]);
	expect(result.content[0]?.text).toMatch(
		/saved it to .*drawings.* not attached/,
	);
});

const refused: [string, () => string[]][] = [
	["outside the roots", () => [join(root, "outside.png")]],
	["a symlink out", () => [join(roots.scratchDir, "link.png")]],
	["a directory", () => [join(roots.scratchDir, "folder")]],
	["a missing file", () => [join(roots.scratchDir, "gone.png")]],
	["not an image", () => [join(roots.scratchDir, "notes.txt")]],
	["over the size limit", () => [join(roots.scratchDir, "huge.png")]],
	[
		"over the count limit",
		() => Array(REFERENCE_IMAGE_LIMITS.maxImages + 1).fill("lotus.jpg"),
	],
];

for (const [why, paths] of refused)
	test(`a reference ${why} is refused before drawing`, async () => {
		const calls: Call[] = [];
		const { result } = await inTurn(drawer(calls), {
			prompt: "a lotus",
			reference_paths: paths(),
		});
		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toStartWith("Not drawn:");
		expect(calls).toEqual([]);
	});

test("a drawer error is a tool error with its message, and nothing is saved", async () => {
	const before = saved();
	const { result, files } = await inTurn(
		async () => {
			throw new Error("refused: the request violates the content policy");
		},
		{ prompt: "a lotus" },
	);
	expect(result.isError).toBe(true);
	expect(result.content[0]?.text).toContain(
		"refused: the request violates the content policy",
	);
	expect(files).toEqual([]);
	expect(saved()).toEqual(before);
});

test("the tool is offered only with an image provider", () => {
	const plan = { tools: [], mcp: [] } as never;
	const core = {
		readAttachment: () => {},
		confirmationGate: () => {},
		askUser: () => {},
		selfCompactGuard: () => {},
		privateMemory: () => {},
		surfaceFormatting: () => {},
		activeTools: () => {},
	};
	const names = (images?: ImageDrawer) =>
		sessionExtensions(plan, {} as never, {
			...core,
			...imageTools(images, roots),
		}).map((extension) => extension.name);
	expect(names(drawer([]))).toContain("generate-image");
	expect(names()).not.toContain("generate-image");
});

test("generate_image is owner-only by default", () => {
	expect(CORE_TOOL_TIERS[GENERATE_IMAGE_TOOL]).toBeUndefined();
	expect(toolTiers().minTier(GENERATE_IMAGE_TOOL)).toBe("owner");
});
