import { expect, test } from "bun:test";
import { attachReplyFile, withReplyFiles } from "./index.ts";

test("the public standalone collector forwards files only from a successful complete turn", async () => {
	const file = { name: "picture.png", data: new Uint8Array([1]) };
	expect(
		await withReplyFiles(true, async () => {
			attachReplyFile(file);
			return { ok: true, text: "Done" };
		}),
	).toEqual({ ok: true, text: "Done", files: [file] });
	expect(
		await withReplyFiles(true, async () => {
			attachReplyFile(file);
			return { ok: false, error: new Error("Failed") };
		}),
	).toMatchObject({ ok: false });
	expect(() => attachReplyFile(file)).toThrow("running conversation turn");
});
