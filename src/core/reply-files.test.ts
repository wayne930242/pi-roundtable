import { expect, test } from "bun:test";
import {
	attachReplyFile,
	REPLY_FILE_LIMITS,
	ReplyFileError,
	withoutReplyFiles,
	withReplyFiles,
} from "./reply-files.ts";
import { turnAnswer } from "./runtime/turn-answer.ts";

const file = () => ({ name: "image.png", data: new Uint8Array([1, 2, 3]) });
const emptyAssistant = { role: "assistant", stopReason: "stop", content: [] };
const answer = () => turnAnswer([emptyAssistant], false);

test("a successful textless answer delivers files; empty without files still fails", async () => {
	const result = await withReplyFiles(true, async () => {
		attachReplyFile(file());
		return answer();
	});
	expect(result).toEqual({ ok: true, text: "", files: [file()] });
	expect((await withReplyFiles(true, async () => answer())).ok).toBe(false);
});

test("failed, stopped, and thrown turns discard files; nothing leaks into the next turn", async () => {
	for (const stopped of [false, true]) {
		const result = await withReplyFiles(true, async () => {
			attachReplyFile(file());
			return {
				ok: false,
				error: new Error("failed"),
				...(stopped ? { stopped: true as const } : {}),
			};
		});
		expect(result.ok).toBe(false);
		expect("files" in result).toBe(false);
	}
	await expect(
		withReplyFiles(true, async () => {
			attachReplyFile(file());
			throw new Error("crashed");
		}),
	).rejects.toThrow("crashed");
	expect(
		await withReplyFiles(true, async () => ({ ok: true, text: "next" })),
	).toEqual({ ok: true, text: "next" });
});

test("unsupported surfaces, outside-turn calls, and transient tasks refuse attachments clearly", async () => {
	expect(() => attachReplyFile(file())).toThrow(ReplyFileError);
	await expect(
		withReplyFiles(false, async () => {
			attachReplyFile(file());
			return answer();
		}),
	).rejects.toThrow("does not support reply files");
	await withReplyFiles(true, async () => {
		await expect(
			withoutReplyFiles(async () => attachReplyFile(file())),
		).rejects.toThrow("requires a running conversation turn");
		attachReplyFile(file());
		return answer();
	});
});

test("files are copied at attachment time; names and byte arrays are validated", async () => {
	const original = file();
	const result = await withReplyFiles(true, async () => {
		for (const name of [
			"",
			" ",
			"../x.png",
			"x/y",
			"x\\y",
			".",
			"..",
			"a\n.png",
			"x".repeat(256),
		])
			expect(() => attachReplyFile({ ...original, name })).toThrow("filename");
		expect(() =>
			attachReplyFile({ name: "empty", data: new Uint8Array() }),
		).toThrow("non-empty Uint8Array");
		attachReplyFile(original);
		original.data.fill(9);
		original.name = "changed";
		return answer();
	});
	expect(result.ok && result.files).toEqual([file()]);
});

test("count, per-file size, and total bytes are bounded, with exact boundaries accepted", async () => {
	await withReplyFiles(true, async () => {
		for (let n = 0; n < REPLY_FILE_LIMITS.maxFiles; n++)
			attachReplyFile(file());
		expect(() => attachReplyFile(file())).toThrow("at most 10 reply files");
		return answer();
	});
	await withReplyFiles(true, async () => {
		expect(() =>
			attachReplyFile({
				name: "large",
				data: new Uint8Array(REPLY_FILE_LIMITS.maxFileBytes + 1),
			}),
		).toThrow("at most 10485760 bytes");
		const data = new Uint8Array(REPLY_FILE_LIMITS.maxFileBytes);
		for (let n = 0; n < 5; n++) attachReplyFile({ name: `part-${n}`, data });
		expect(() => attachReplyFile(file())).toThrow("52428800 bytes in total");
		return answer();
	});
});

test("concurrent turns stay isolated and detached work cannot attach after its turn ends", async () => {
	let release = () => {};
	const waiting = new Promise<void>((resolve) => {
		release = resolve;
	});
	let late: Promise<void> | undefined;
	const results = await Promise.all(
		["a", "b"].map((name) =>
			withReplyFiles(true, async () => {
				await Promise.resolve();
				attachReplyFile({ ...file(), name });
				if (name === "a")
					late = (async () => {
						await waiting;
						expect(() => attachReplyFile(file())).toThrow(
							"requires a running conversation turn",
						);
					})();
				return answer();
			}),
		),
	);
	expect(
		results.map(
			(result) => result.ok && result.files?.map((file) => file.name),
		),
	).toEqual([["a"], ["b"]]);
	release();
	await late;
});

test("replacement runtime files use the same validation, including unsupported surfaces", async () => {
	await expect(
		withReplyFiles(false, async () => ({
			ok: true,
			text: "done",
			files: [file()],
		})),
	).rejects.toThrow("does not support reply files");
});
