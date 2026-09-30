import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCanvas, loadImage } from "canvas";
import { NO_ATTACHMENTS } from "../domain/attachment.ts";
import { readAttachment } from "../shared/attachment-reader.ts";
import { safeFileName } from "./attachment-fetcher.ts";
import { prepareImage } from "./image-prep.ts";
import { withAttachmentsBlock } from "./prompt-block.ts";

const dir = mkdtempSync(join(tmpdir(), "roundtable-read-"));

describe("safeFileName", () => {
	test("keeps names readable and strips path parts", () => {
		expect(safeFileName("отчёт v2.pdf")).toBe("отчёт v2.pdf");
		expect(safeFileName("../../etc/passwd")).toBe("__.._etc_passwd");
		expect(safeFileName("")).toBe("file");
	});
});

describe("prepareImage", () => {
	test("an image over the side limit is downscaled to 2,000 px JPEG", async () => {
		const canvas = createCanvas(9000, 100);
		const path = join(dir, "wide.png");
		await Bun.write(path, canvas.toBuffer("image/png"));
		const image = await prepareImage({ path, contentType: "image/png" });
		expect(image.mimeType).toBe("image/jpeg");
		const decoded = await loadImage(Buffer.from(image.data, "base64"));
		expect(decoded.width).toBe(2000);
	});
});

describe("readAttachment", () => {
	test("reads text in pieces and refuses paths and binaries", async () => {
		await Bun.write(join(dir, "a.txt"), "x".repeat(70_000));
		const first = await readAttachment(dir, "a.txt");
		expect(first.text).toHaveLength(60_000);
		expect(first.total).toBe(70_000);
		expect((await readAttachment(dir, "a.txt", 60_000)).text).toHaveLength(
			10_000,
		);
		await expect(readAttachment(dir, "../a.txt")).rejects.toThrow(
			"not an attachment name",
		);
		await Bun.write(join(dir, "b.bin"), new Uint8Array([0, 1, 2, 255]));
		await expect(readAttachment(dir, "b.bin")).rejects.toThrow(
			"not a text or PDF file",
		);
		await expect(readAttachment(dir, "none.txt")).rejects.toThrow(
			"no attachment named",
		);
	});
});

describe("withAttachmentsBlock", () => {
	test("adds nothing without attachments", () => {
		expect(withAttachmentsBlock("hi", NO_ATTACHMENTS)).toBe("hi");
	});

	test("lists files and failures", () => {
		const text = withAttachmentsBlock("hi", {
			files: [
				{
					name: "a.pdf",
					file: "m-0-a.pdf",
					path: "/x",
					contentType: "application/pdf",
					size: 2048,
					fromReference: false,
				},
			],
			images: [],
			failures: [
				{ name: "b.mov", reason: "larger than 25 MB", fromReference: true },
			],
		});
		expect(text).toContain(
			'- m-0-a.pdf (original name "a.pdf", application/pdf, 2 KB)',
		);
		expect(text).toContain(
			'"b.mov" from the replied-to message could not be received: larger than 25 MB',
		);
	});
});
