import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { defineTool, type ToolTurn } from "../define.ts";
import { silentLogger } from "../log.ts";
import type { SessionContext } from "../sessions.ts";
import { AttachmentStore } from "./attachment-store.ts";
import { openAttachment } from "./tool-attachment.ts";

const dirs: string[] = [];
const scratch = () => {
	const dir = mkdtempSync(join(tmpdir(), "roundtable-tool-att-"));
	dirs.push(dir);
	return dir;
};
afterAll(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const CHANNEL = "web:5a1c";
const PRINCIPAL = "principal-ada";

async function usedUpload(dataDir: string) {
	const store = new AttachmentStore({
		dataDir,
		registry: () => undefined,
		logger: silentLogger(),
	});
	const saved = await store.save(CHANNEL, PRINCIPAL, {
		name: "session.json",
		contentType: "application/json",
		data: new TextEncoder().encode('{"events":[1,2]}'),
	});
	const turn = await store.turnAttachments(CHANNEL, PRINCIPAL, [saved.file]);
	const [file] = turn.files;
	if (!file) throw new Error("the file was not used");
	return file;
}

describe("openAttachment", () => {
	test("opens a file of the conversation with its name, type, size and bytes", async () => {
		const dataDir = scratch();
		const file = await usedUpload(dataDir);
		const dir = join(file.path, "..");
		const opened = await openAttachment(dir, file.file);
		expect(opened).toMatchObject({
			file: file.file,
			name: "session.json",
			contentType: "application/json",
			size: 16,
		});
		expect(new TextDecoder().decode(await opened.bytes())).toBe(
			'{"events":[1,2]}',
		);
	});

	test("a file the core fetched without a record is named by its file name and typed by its extension", async () => {
		const dir = scratch();
		await Bun.write(join(dir, "m1-0-notes.txt"), "hello");
		const opened = await openAttachment(dir, "m1-0-notes.txt");
		expect(opened.name).toBe("m1-0-notes.txt");
		expect(opened.contentType).toStartWith("text/plain");
		expect(opened.size).toBe(5);
	});

	test("refuses a path, a hidden name, and a file that is not there", async () => {
		const dir = scratch();
		await Bun.write(join(dir, "a.txt"), "x");
		for (const bad of ["../a.txt", "sub/a.txt", ".records", "", "missing.txt"])
			await expect(openAttachment(dir, bad)).rejects.toThrow(
				/not an attachment name|no attachment named/,
			);
	});
});

describe("ToolTurn.attachment", () => {
	type Registered = {
		execute(
			id: string,
			params: unknown,
		): Promise<{ content: { text: string }[]; isError?: boolean }>;
	};

	function register(
		run: (turn: ToolTurn) => Promise<string>,
		attachmentDir?: string,
	): Registered {
		const tool = defineTool({
			name: "attachment_probe",
			description: "Reads an attachment.",
			parameters: Type.Object({}),
			minTier: "member",
			run: (_args, turn) => run(turn),
		});
		const registered: Registered[] = [];
		const context = {
			speaker: () => undefined,
			turnChannel: CHANNEL,
			...(attachmentDir ? { attachmentDir } : {}),
		} as unknown as SessionContext;
		tool.session.snapshot().factory(context)?.({
			registerTool: (def: Registered) => registered.push(def),
		} as unknown as ExtensionAPI);
		const [one] = registered;
		if (!one) throw new Error("nothing was registered");
		return one;
	}

	test("a tool reads the bytes of the conversation's attachment", async () => {
		const file = await usedUpload(scratch());
		const dir = join(file.path, "..");
		const tool = register(async (turn) => {
			const attachment = await turn.attachment(file.file);
			return `${attachment.name}|${attachment.contentType}|${new TextDecoder().decode(await attachment.bytes())}`;
		}, dir);
		const result = await tool.execute("c", {});
		expect(result.content[0]?.text).toBe(
			'session.json|application/json|{"events":[1,2]}',
		);
	});

	test("a path or an unknown name reaches the model as a refusal it can correct", async () => {
		const dir = scratch();
		const tool = register(async (turn) => {
			await turn.attachment("../x");
			return "unreachable";
		}, dir);
		const result = await tool.execute("c", {});
		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain("not an attachment name");
	});

	test("a session that keeps no attachments refuses the call by saying so", async () => {
		const tool = register(async (turn) => {
			await turn.attachment("a.txt");
			return "unreachable";
		});
		const result = await tool.execute("c", {});
		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain("keeps no attachments");
	});
});
