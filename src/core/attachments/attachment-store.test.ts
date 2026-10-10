import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCanvas } from "canvas";
import { AttachmentRefusal } from "../contract/attachments.ts";
import type { ConversationRecord } from "../conversations/conversation-registry.ts";
import { silentLogger } from "../log.ts";
import { readAttachment } from "../shared/attachment-reader.ts";
import { ownerAttachmentDir } from "./attachment-dir.ts";
import { AttachmentStore } from "./attachment-store.ts";

const roots: string[] = [];
function root() {
	const dir = mkdtempSync(join(tmpdir(), "roundtable-att-store-"));
	roots.push(dir);
	return dir;
}
afterAll(() => {
	for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

const CHANNEL = "web:7d1c0f0a";
const ADA = "principal-ada";
const BOB = "principal-bob";

function record(
	visibility: "private" | "shared",
	principalId?: string,
): ConversationRecord {
	return {
		key: CHANNEL,
		kind: "support",
		visibility,
		...(principalId ? { principalId } : {}),
		surface: "web",
		createdAt: new Date(),
		lastActiveAt: new Date(),
	};
}

function store(known?: ConversationRecord) {
	const dataDir = root();
	return {
		dataDir,
		store: new AttachmentStore({
			dataDir,
			registry: () => ({ get: async () => known }),
			logger: silentLogger(),
		}),
	};
}

const json = (text: string) => ({
	name: "session.json",
	contentType: "application/json",
	data: new TextEncoder().encode(text),
});

async function png() {
	return {
		name: "screenshot.png",
		contentType: "image/png",
		data: new Uint8Array(createCanvas(8, 8).toBuffer("image/png")),
	};
}

async function refusal(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof AttachmentRefusal) return error.code;
		throw error;
	}
	throw new Error("expected an AttachmentRefusal");
}

describe("AttachmentStore.save", () => {
	test("stages the file outside the conversation's attachment directory", async () => {
		const { store: attachments, dataDir } = store(record("private", ADA));
		const saved = await attachments.save(CHANNEL, ADA, json("[]"));
		expect(saved).toMatchObject({
			name: "session.json",
			contentType: "application/json",
			size: 2,
			fromReference: false,
		});
		expect(saved.file).toEndWith("-session.json");
		expect(await Bun.file(saved.path).text()).toBe("[]");
		expect(
			existsSync(join(ownerAttachmentDir(dataDir, CHANNEL), saved.file)),
		).toBe(false);
	});

	test("keeps the name of a path-like upload inside the staging directory", async () => {
		const { store: attachments } = store();
		const saved = await attachments.save(CHANNEL, ADA, {
			...json("{}"),
			name: "../../etc/passwd",
		});
		expect(saved.file).not.toContain("/");
		expect(saved.file.startsWith(".")).toBe(false);
		expect(saved.name).toBe("../../etc/passwd");
	});

	test("refuses a file over the core's limit", async () => {
		const { store: attachments } = store();
		const big = {
			...json(""),
			data: new Uint8Array(25 * 1024 * 1024 + 1),
		};
		expect(await refusal(attachments.save(CHANNEL, ADA, big))).toBe(
			"too_large",
		);
	});

	test("refuses another principal in a private conversation, and accepts it in a shared one", async () => {
		const priv = store(record("private", ADA));
		expect(await refusal(priv.store.save(CHANNEL, BOB, json("{}")))).toBe(
			"forbidden",
		);
		const shared = store(record("shared"));
		await shared.store.save(CHANNEL, BOB, json("{}"));
		const unrecorded = store(undefined);
		await unrecorded.store.save(CHANNEL, BOB, json("{}"));
	});
});

describe("AttachmentStore.turnAttachments", () => {
	test("moves the files into the conversation and prepares images", async () => {
		const { store: attachments, dataDir } = store(record("private", ADA));
		const image = await attachments.save(CHANNEL, ADA, await png());
		const data = await attachments.save(CHANNEL, ADA, json('{"a":1}'));
		const turn = await attachments.turnAttachments(CHANNEL, ADA, [
			image.file,
			data.file,
		]);
		expect(turn.files.map((file) => file.name)).toEqual([
			"screenshot.png",
			"session.json",
		]);
		expect(turn.images).toHaveLength(1);
		expect(turn.images[0]?.mimeType).toBe("image/png");
		expect(turn.failures).toEqual([]);
		const dir = ownerAttachmentDir(dataDir, CHANNEL);
		for (const file of turn.files) {
			expect(file.path).toBe(join(dir, file.file));
			expect(existsSync(file.path)).toBe(true);
		}
		expect((await readAttachment(dir, data.file)).text).toBe('{"a":1}');
		expect(existsSync(image.path)).toBe(false);
	});

	test("reports an image that cannot be decoded instead of dropping the turn", async () => {
		const { store: attachments } = store();
		const bad = await attachments.save(CHANNEL, ADA, {
			name: "broken.png",
			contentType: "image/png",
			data: new Uint8Array([1, 2, 3]),
		});
		const turn = await attachments.turnAttachments(CHANNEL, ADA, [bad.file]);
		expect(turn.files).toHaveLength(1);
		expect(turn.images).toHaveLength(0);
		expect(turn.failures.map((f) => f.name)).toEqual(["broken.png"]);
	});

	test("refuses a file that is unknown, already used, a path, or another principal's", async () => {
		const { store: attachments } = store();
		const mine = await attachments.save(CHANNEL, ADA, json("{}"));
		expect(
			await refusal(attachments.turnAttachments(CHANNEL, BOB, [mine.file])),
		).toBe("unknown_file");
		expect(
			await refusal(attachments.turnAttachments(CHANNEL, ADA, ["nope.json"])),
		).toBe("unknown_file");
		expect(
			await refusal(
				attachments.turnAttachments(CHANNEL, ADA, [`../${mine.file}`]),
			),
		).toBe("unknown_file");
		expect(
			await refusal(attachments.turnAttachments(CHANNEL, ADA, [".meta"])),
		).toBe("unknown_file");
		await attachments.turnAttachments(CHANNEL, ADA, [mine.file]);
		expect(
			await refusal(attachments.turnAttachments(CHANNEL, ADA, [mine.file])),
		).toBe("unknown_file");
	});

	test("a file staged for one conversation cannot be used in another", async () => {
		const { store: attachments } = store();
		const mine = await attachments.save(CHANNEL, ADA, json("{}"));
		expect(
			await refusal(attachments.turnAttachments("web:other", ADA, [mine.file])),
		).toBe("unknown_file");
	});

	test("refuses the whole set when one file is unknown and moves none", async () => {
		const { store: attachments } = store();
		const mine = await attachments.save(CHANNEL, ADA, json("{}"));
		await refusal(
			attachments.turnAttachments(CHANNEL, ADA, [mine.file, "missing.json"]),
		);
		const turn = await attachments.turnAttachments(CHANNEL, ADA, [mine.file]);
		expect(turn.files).toHaveLength(1);
	});

	test("refuses another principal in a private conversation even for their own upload", async () => {
		const priv = store(record("private", ADA));
		const staged = await priv.store.save(CHANNEL, ADA, json("{}"));
		expect(
			await refusal(priv.store.turnAttachments(CHANNEL, BOB, [staged.file])),
		).toBe("forbidden");
	});

	test("a shared conversation lets each principal use their own upload", async () => {
		const { store: attachments } = store(record("shared"));
		const bobs = await attachments.save(CHANNEL, BOB, json("{}"));
		const turn = await attachments.turnAttachments(CHANNEL, BOB, [bobs.file]);
		expect(turn.files).toHaveLength(1);
	});
});

describe("AttachmentStore staging", () => {
	test("remove discards a staged file once", async () => {
		const { store: attachments } = store();
		const staged = await attachments.save(CHANNEL, ADA, json("{}"));
		expect(await attachments.remove(CHANNEL, BOB, staged.file)).toBe(false);
		expect(existsSync(staged.path)).toBe(true);
		expect(await attachments.remove(CHANNEL, ADA, staged.file)).toBe(true);
		expect(existsSync(staged.path)).toBe(false);
		expect(await attachments.remove(CHANNEL, ADA, staged.file)).toBe(false);
	});

	test("discardPending drops staged files older than the cutoff, with their records", async () => {
		const { store: attachments, dataDir } = store();
		const old = await attachments.save(CHANNEL, ADA, json("{}"));
		const fresh = await attachments.save(CHANNEL, BOB, json("{}"));
		const hourAgo = new Date(Date.now() - 3_600_000);
		utimesSync(old.path, hourAgo, hourAgo);
		const cutoff = new Date(Date.now() - 1_800_000);
		expect(await attachments.discardPending(cutoff)).toBe(1);
		expect(existsSync(old.path)).toBe(false);
		expect(existsSync(fresh.path)).toBe(true);
		expect(
			await refusal(attachments.turnAttachments(CHANNEL, ADA, [old.file])),
		).toBe("unknown_file");
		const meta = await readdir(join(dataDir, "attachments-pending"), {
			recursive: true,
		});
		expect(meta.filter((entry) => entry.endsWith(`${old.file}.json`))).toEqual(
			[],
		);
		expect(await attachments.discardPending(cutoff)).toBe(0);
	});

	test("discardPending leaves files already used by a turn", async () => {
		const { store: attachments } = store();
		const used = await attachments.save(CHANNEL, ADA, json("{}"));
		const turn = await attachments.turnAttachments(CHANNEL, ADA, [used.file]);
		const longAgo = new Date(Date.now() - 86_400_000 * 3);
		utimesSync(turn.files[0]?.path ?? "", longAgo, longAgo);
		expect(await attachments.discardPending(new Date())).toBe(0);
		expect(existsSync(turn.files[0]?.path ?? "")).toBe(true);
	});

	test("pendingBytes counts what one principal has staged and not yet used", async () => {
		const { store: attachments } = store();
		expect(await attachments.pendingBytes(ADA)).toBe(0);
		const a = await attachments.save(CHANNEL, ADA, json("12345"));
		await attachments.save("web:other", ADA, json("123"));
		await attachments.save(CHANNEL, BOB, json("1234567"));
		expect(await attachments.pendingBytes(ADA)).toBe(8);
		await attachments.turnAttachments(CHANNEL, ADA, [a.file]);
		expect(await attachments.pendingBytes(ADA)).toBe(3);
	});
});
