import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AttachmentRefusal } from "../contract/attachments.ts";
import { silentLogger } from "../log.ts";
import { readAttachment } from "../shared/attachment-reader.ts";
import {
	discardConversationFiles,
	ownerAttachmentDir,
} from "./attachment-dir.ts";
import { AttachmentStore } from "./attachment-store.ts";
import {
	AttachmentExpiredError,
	AttachmentLookupError,
	openAttachment,
} from "./tool-attachment.ts";

const roots: string[] = [];
function root() {
	const dir = mkdtempSync(join(tmpdir(), "roundtable-att-expiry-"));
	roots.push(dir);
	return dir;
}
afterAll(() => {
	for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

const CHANNEL = "web:7d1c0f0a";
const ADA = "principal-ada";
const BOB = "principal-bob";

function store(now?: () => number) {
	const dataDir = root();
	return {
		dataDir,
		store: new AttachmentStore({
			dataDir,
			registry: () => undefined,
			logger: silentLogger(),
			...(now ? { now } : {}),
		}),
	};
}

const json = (text: string) => ({
	name: "session.json",
	contentType: "application/json",
	data: new TextEncoder().encode(text),
});

async function refusal(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof AttachmentRefusal) return error.code;
		throw error;
	}
	throw new Error("expected an AttachmentRefusal");
}

describe("AttachmentStore.expireUsed", () => {
	const HOUR = 3_600_000;

	/** A store whose clock the test moves. */
	function clocked() {
		const clock = { at: 1_000_000_000_000 };
		return { clock, ...store(() => clock.at) };
	}

	test("removes used files older than the age, with their bytes from the owner's tally", async () => {
		const { store: attachments, clock } = clocked();
		const old = await attachments.save(CHANNEL, ADA, json("12345"));
		await attachments.turnAttachments(CHANNEL, ADA, [old.file]);
		clock.at += 2 * HOUR;
		const fresh = await attachments.save(CHANNEL, ADA, json("123"));
		const [kept] = (
			await attachments.turnAttachments(CHANNEL, ADA, [fresh.file])
		).files;
		clock.at += HOUR;
		expect(await attachments.expireUsed({ olderThanMs: 2 * HOUR })).toEqual({
			files: 1,
			bytes: 5,
			unattributedBytes: 0,
		});
		expect(existsSync(old.path)).toBe(false);
		expect(existsSync(kept?.path ?? "")).toBe(true);
		// Only the removed bytes come back: 3 are still used, so 5 more fit under 8 and 6 do not.
		const more = await attachments.save("web:more", ADA, json("12345"));
		await attachments.turnAttachments("web:more", ADA, [more.file], {
			usedBytesLimit: 8,
		});
		const over = await attachments.save("web:over", ADA, json("1"));
		expect(
			await refusal(
				attachments.turnAttachments("web:over", ADA, [over.file], {
					usedBytesLimit: 8,
				}),
			),
		).toBe("quota_exceeded");
	});

	test("leaves the files of a turn younger than the age, and files still waiting", async () => {
		const { store: attachments, clock } = clocked();
		const used = await attachments.save(CHANNEL, ADA, json("1"));
		const [taken] = (
			await attachments.turnAttachments(CHANNEL, ADA, [used.file])
		).files;
		const waiting = await attachments.save(CHANNEL, ADA, json("2"));
		clock.at += HOUR;
		expect(await attachments.expireUsed({ olderThanMs: 2 * HOUR })).toEqual({
			files: 0,
			bytes: 0,
			unattributedBytes: 0,
		});
		expect(existsSync(taken?.path ?? "")).toBe(true);
		expect(existsSync(waiting.path)).toBe(true);
		clock.at += 24 * HOUR;
		await attachments.expireUsed({ olderThanMs: 2 * HOUR });
		expect(existsSync(waiting.path)).toBe(true);
	});

	test("counts the age from the turn that used the file, not from its upload", async () => {
		const { store: attachments, clock } = clocked();
		const saved = await attachments.save(CHANNEL, ADA, json("12"));
		clock.at += 10 * HOUR;
		await attachments.turnAttachments(CHANNEL, ADA, [saved.file]);
		clock.at += HOUR;
		expect(
			(await attachments.expireUsed({ olderThanMs: 2 * HOUR })).files,
		).toBe(0);
		clock.at += 2 * HOUR;
		expect(
			(await attachments.expireUsed({ olderThanMs: 2 * HOUR })).files,
		).toBe(1);
	});

	test("lowers each owner's tally only by their own files", async () => {
		const { store: attachments, clock } = clocked();
		const a = await attachments.save(CHANNEL, ADA, json("1234"));
		const b = await attachments.save(CHANNEL, BOB, json("123456"));
		await attachments.turnAttachments(CHANNEL, ADA, [a.file]);
		await attachments.turnAttachments(CHANNEL, BOB, [b.file]);
		clock.at += HOUR;
		const later = await attachments.save("web:later", BOB, json("12"));
		await attachments.turnAttachments("web:later", BOB, [later.file]);
		expect(
			await attachments.expireUsed({ olderThanMs: HOUR / 2 }),
		).toMatchObject({
			files: 2,
			bytes: 10,
		});
		// Ada used nothing now, Bob 2 bytes.
		const adas = await attachments.save("web:ada2", ADA, json("123456"));
		await attachments.turnAttachments("web:ada2", ADA, [adas.file], {
			usedBytesLimit: 6,
		});
		const bobs = await attachments.save("web:bob2", BOB, json("123456"));
		expect(
			await refusal(
				attachments.turnAttachments("web:bob2", BOB, [bobs.file], {
					usedBytesLimit: 6,
				}),
			),
		).toBe("quota_exceeded");
	});

	test("answers a removed file with a refusal that names no path or file name", async () => {
		const { store: attachments, clock, dataDir } = clocked();
		const saved = await attachments.save(CHANNEL, ADA, json("12"));
		const [taken] = (
			await attachments.turnAttachments(CHANNEL, ADA, [saved.file])
		).files;
		clock.at += 3 * HOUR;
		await attachments.expireUsed({ olderThanMs: HOUR });
		const dir = ownerAttachmentDir(dataDir, CHANNEL);
		const file = taken?.file ?? "";
		const fromReader = await readAttachment(dir, file).catch((e: unknown) => e);
		expect(fromReader).toBeInstanceOf(AttachmentExpiredError);
		expect((fromReader as Error).message).toContain(
			"removed after its retention period",
		);
		expect((fromReader as Error).message).not.toContain(dataDir);
		const fromTool = await openAttachment(dir, file).catch((e: unknown) => e);
		expect(fromTool).toBeInstanceOf(AttachmentExpiredError);
		expect(fromTool).toBeInstanceOf(AttachmentLookupError);
		// The mark keeps neither the person's file name nor its type.
		const mark = await Bun.file(join(dir, ".records", `${file}.json`)).text();
		expect(mark).not.toContain("session.json");
		expect(mark).not.toContain("application/json");
	});

	test("a second sweep finds nothing and the mark stays", async () => {
		const { store: attachments, clock } = clocked();
		const saved = await attachments.save(CHANNEL, ADA, json("12"));
		await attachments.turnAttachments(CHANNEL, ADA, [saved.file]);
		clock.at += 3 * HOUR;
		expect((await attachments.expireUsed({ olderThanMs: HOUR })).files).toBe(1);
		expect(await attachments.expireUsed({ olderThanMs: HOUR })).toEqual({
			files: 0,
			bytes: 0,
			unattributedBytes: 0,
		});
	});

	test("a file used before owners were recorded goes to the only person with a tally in its conversation", async () => {
		const { store: attachments, dataDir } = store();
		const saved = await attachments.save(CHANNEL, ADA, json("1234"));
		const [taken] = (
			await attachments.turnAttachments(CHANNEL, ADA, [saved.file])
		).files;
		// Make the record look as 0.9.8 wrote it, and the file old.
		const dir = ownerAttachmentDir(dataDir, CHANNEL);
		const recordPath = join(dir, ".records", `${taken?.file}.json`);
		await Bun.write(
			recordPath,
			JSON.stringify({ name: "session.json", contentType: "application/json" }),
		);
		const longAgo = new Date(Date.now() - 86_400_000);
		utimesSync(taken?.path ?? "", longAgo, longAgo);
		expect(await attachments.expireUsed({ olderThanMs: HOUR })).toEqual({
			files: 1,
			bytes: 4,
			unattributedBytes: 0,
		});
		const next = await attachments.save("web:next", ADA, json("123456"));
		await attachments.turnAttachments("web:next", ADA, [next.file], {
			usedBytesLimit: 6,
		});
	});

	test("a legacy file in a conversation with two tallies is removed but no tally shrinks", async () => {
		const { store: attachments, dataDir } = store();
		const a = await attachments.save(CHANNEL, ADA, json("1234"));
		const b = await attachments.save(CHANNEL, BOB, json("12"));
		const [taken] = (await attachments.turnAttachments(CHANNEL, ADA, [a.file]))
			.files;
		await attachments.turnAttachments(CHANNEL, BOB, [b.file]);
		const dir = ownerAttachmentDir(dataDir, CHANNEL);
		await Bun.write(
			join(dir, ".records", `${taken?.file}.json`),
			JSON.stringify({ name: "session.json", contentType: "application/json" }),
		);
		const longAgo = new Date(Date.now() - 86_400_000);
		utimesSync(taken?.path ?? "", longAgo, longAgo);
		expect(await attachments.expireUsed({ olderThanMs: HOUR })).toEqual({
			files: 1,
			bytes: 4,
			unattributedBytes: 4,
		});
		expect(existsSync(taken?.path ?? "")).toBe(false);
	});

	test("a sweep racing a turn of the same person leaves a consistent tally", async () => {
		const { store: attachments, clock } = clocked();
		const first = await attachments.save(CHANNEL, ADA, json("12345"));
		await attachments.turnAttachments(CHANNEL, ADA, [first.file]);
		clock.at += 3 * HOUR;
		const second = await attachments.save("web:two", ADA, json("123"));
		await Promise.all([
			attachments.expireUsed({ olderThanMs: HOUR }),
			attachments.turnAttachments("web:two", ADA, [second.file]),
		]);
		// 3 bytes are used now, whichever came first.
		const third = await attachments.save("web:three", ADA, json("12345"));
		await attachments.turnAttachments("web:three", ADA, [third.file], {
			usedBytesLimit: 8,
		});
		const fourth = await attachments.save("web:four", ADA, json("1"));
		expect(
			await refusal(
				attachments.turnAttachments("web:four", ADA, [fourth.file], {
					usedBytesLimit: 8,
				}),
			),
		).toBe("quota_exceeded");
	});

	test("a sweep racing a conversation's deletion neither fails nor brings the conversation back", async () => {
		const { store: attachments, clock, dataDir } = clocked();
		const saved = await attachments.save(CHANNEL, ADA, json("12345"));
		await attachments.turnAttachments(CHANNEL, ADA, [saved.file]);
		clock.at += 3 * HOUR;
		await Promise.all([
			attachments.expireUsed({ olderThanMs: HOUR }),
			discardConversationFiles(dataDir, CHANNEL),
		]);
		await discardConversationFiles(dataDir, CHANNEL);
		expect(existsSync(ownerAttachmentDir(dataDir, CHANNEL))).toBe(false);
		expect(existsSync(join(dataDir, "attachments-used"))).toBe(true);
		expect(await readdir(join(dataDir, "attachments-used"))).toEqual([]);
	});
});
