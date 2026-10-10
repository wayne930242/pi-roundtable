import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { discordAdminExtension } from "../modules/discord-admin/discord-admin.ts";
import { resolveChannelFiles } from "./channel-files.ts";
import {
	CHANNEL_UPLOAD_MAX_BYTES,
	ChannelToolError,
	parseChannelTool,
} from "./channel-operations.ts";

let root = "";
let roots: { workspace: string; scratchDir: string };
const channelId = "123";

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "channel-files-"));
	roots = { workspace: join(root, "work"), scratchDir: join(root, "scratch") };
	mkdirSync(roots.workspace);
	mkdirSync(join(roots.scratchDir, "card"), { recursive: true });
	writeFileSync(join(roots.scratchDir, "card", "sigil.png"), "PNGDATA");
	writeFileSync(join(root, "secret.txt"), "secret");
	symlinkSync(join(root, "secret.txt"), join(roots.scratchDir, "link.txt"));
	symlinkSync(
		join(roots.scratchDir, "card", "sigil.png"),
		join(roots.workspace, "inside.png"),
	);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const send = (files: unknown[]) => ({ channelId, files });

async function refusal(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
	} catch (error) {
		expect(error).toBeInstanceOf(ChannelToolError);
		return (error as Error).message;
	}
	throw new Error("expected a refusal");
}

describe("files by path", () => {
	test("a path in the scratch dir becomes the file's bytes under its base name", async () => {
		const path = join(roots.scratchDir, "card", "sigil.png");
		const args = await resolveChannelFiles(
			"discord_send_message",
			send([{ path, description: "a sigil" }]),
			roots,
		);
		expect(args.files).toEqual([
			{
				filename: "sigil.png",
				dataBase64: Buffer.from("PNGDATA").toString("base64"),
				description: "a sigil",
			},
		]);
		expect(() => parseChannelTool("discord_send_message", args)).not.toThrow();
	});

	test("a filename overrides the base name, and a relative path resolves in the workspace", async () => {
		const args = await resolveChannelFiles(
			"discord_edit_message",
			{
				channelId,
				messageId: "456",
				files: [{ path: "inside.png", filename: "mark.png" }],
			},
			roots,
		);
		expect(args.files).toEqual([
			{
				filename: "mark.png",
				dataBase64: Buffer.from("PNGDATA").toString("base64"),
			},
		]);
	});

	test("each file needs exactly one of path or dataBase64", async () => {
		const path = join(roots.scratchDir, "card", "sigil.png");
		for (const file of [
			{ path, dataBase64: "AAAA", filename: "a.png" },
			{ filename: "a.png" },
		])
			expect(
				await refusal(
					resolveChannelFiles("discord_send_message", send([file]), roots),
				),
			).toMatch(/exactly one of path or dataBase64/);
		expect(
			await refusal(
				resolveChannelFiles(
					"discord_send_message",
					send([{ dataBase64: "AAAA" }]),
					roots,
				),
			),
		).toMatch(/needs a filename/);
	});

	test("outside paths, symlinks out, directories, and missing files are refused by name", async () => {
		const cases: [string, RegExp][] = [
			[join(root, "secret.txt"), /outside the workspace and the scratch dir/],
			[join(roots.scratchDir, "link.txt"), /outside the workspace/],
			["../secret.txt", /outside the workspace/],
			[join(roots.scratchDir, "card"), /is not a file/],
			[join(roots.scratchDir, "gone.png"), /does not exist/],
		];
		for (const [path, reason] of cases) {
			const message = await refusal(
				resolveChannelFiles("discord_send_message", send([{ path }]), roots),
			);
			expect(message).toMatch(/^INVALID_CHANNEL_FILE_PATH: /);
			expect(message).toContain(path);
			expect(message).toMatch(reason);
		}
	});

	test("a session without a workspace takes only dataBase64", async () => {
		const path = join(roots.scratchDir, "card", "sigil.png");
		expect(
			await refusal(
				resolveChannelFiles(
					"discord_send_message",
					send([{ path }]),
					undefined,
				),
			),
		).toMatch(/no workspace/);
		const inline = send([{ filename: "a.txt", dataBase64: "AAAA" }]);
		expect(
			await resolveChannelFiles("discord_send_message", inline, undefined),
		).toEqual(inline);
	});

	test("the 8 MiB total counts path files with inline ones", async () => {
		const big = join(roots.scratchDir, "big.bin");
		writeFileSync(big, new Uint8Array(CHANNEL_UPLOAD_MAX_BYTES - 2));
		await resolveChannelFiles(
			"discord_send_message",
			send([{ path: big }]),
			roots,
		);
		expect(
			await refusal(
				resolveChannelFiles(
					"discord_send_message",
					send([{ path: big }, { filename: "a.bin", dataBase64: "AAAA" }]),
					roots,
				),
			),
		).toBe("INVALID_CHANNEL_UPLOAD_SIZE");
	});
});

test("the session's discord_send_message uploads a path file's bytes", async () => {
	const calls: { tool: string; args: Record<string, unknown> }[] = [];
	const tools = new Map<
		string,
		{
			execute(
				id: string,
				params: unknown,
			): Promise<{ content: { text: string }[] }>;
		}
	>();
	discordAdminExtension(
		{
			run: async (tool, args) => {
				calls.push({ tool, args });
				return { id: "1" };
			},
		},
		{
			name: "Owner",
			pronouns: { subject: "they", object: "them", possessive: "their" },
		},
		roots,
	)({
		registerTool: (definition: { name: string }) =>
			tools.set(definition.name, definition as never),
	} as unknown as ExtensionAPI);
	await tools
		.get("discord_send_message")
		?.execute(
			"call",
			send([{ path: join(roots.scratchDir, "card", "sigil.png") }]),
		);
	expect(calls).toEqual([
		{
			tool: "discord_send_message",
			args: send([
				{
					filename: "sigil.png",
					dataBase64: Buffer.from("PNGDATA").toString("base64"),
				},
			]),
		},
	]);
});
