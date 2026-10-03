import { expect, test } from "bun:test";
import {
	lstatSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboundMessage } from "pi-roundtable";
import { partial } from "pi-roundtable/testing";
import { collectPiAttachments } from "./pi-attachments.ts";

test("bounded attachments prepare images from fetched bytes and never follow a guest symlink for host writes", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-att-"));
	const outside = `${root}-outside`;
	writeFileSync(outside, "host data");
	symlinkSync(outside, join(root, "m1-0-image.png"));
	const message = partial<InboundMessage>({
		messageId: "m1",
		reference: undefined,
		attachments: [
			{
				name: "image.png",
				url: "https://files.test/image.png",
				contentType: "image/png",
				size: 3,
			},
			{
				name: "next.png",
				url: "https://files.test/next.png",
				contentType: "image/png",
				size: 3,
			},
		],
	});
	const prepared: Uint8Array[] = [];
	try {
		// SAFETY: offline fixture transport, never a production override.
		const fetchImpl = Object.assign(
			async () => new Response(new Uint8Array([1, 2, 3])),
			{ preconnect: () => {} },
		);
		const result = await collectPiAttachments(message, root, {
			fetchImpl,
			prepareImage: async (bytes, mimeType) => {
				prepared.push(bytes);
				return { data: Buffer.from(bytes).toString("base64"), mimeType };
			},
		});
		expect(readFileSync(outside, "utf8")).toBe("host data");
		expect(result.failures).toHaveLength(1);
		expect(result.files).toHaveLength(1);
		expect(result.images).toEqual([{ data: "AQID", mimeType: "image/png" }]);
		expect(prepared).toEqual([new Uint8Array([1, 2, 3])]);
	} finally {
		rmSync(root, { recursive: true, force: true });
		rmSync(outside, { force: true });
	}
});
test("attachment count and declared body bounds refuse excess before downloading", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-att-"));
	let calls = 0;
	const message = partial<InboundMessage>({
		messageId: "m2",
		reference: undefined,
		attachments: Array.from({ length: 21 }, (_, i) => ({
			name: `file${i}.txt`,
			url: "https://files.test/file.txt",
			contentType: "text/plain",
			size: i === 0 ? 26 * 1024 * 1024 : 1,
		})),
	});
	try {
		// SAFETY: offline fixture transport returns one bounded byte.
		const fetchImpl = Object.assign(
			async () => {
				calls++;
				return new Response("x");
			},
			{ preconnect: () => {} },
		);
		const result = await collectPiAttachments(message, root, {
			fetchImpl,
			prepareImage: async () => {
				throw new Error("No images");
			},
		});
		expect(calls).toBe(19);
		expect(result.failures.map((failure) => failure.reason)).toEqual([
			`larger than 25 MB (${26 * 1024 * 1024} bytes)`,
			"too many attachments",
		]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a guest-planted symlink at the attachments directory is replaced, never followed", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-att-"));
	const outside = mkdtempSync(join(tmpdir(), "pi-att-out-"));
	const dir = join(root, "attachments");
	try {
		symlinkSync(outside, dir);
		const message = partial<InboundMessage>({
			messageId: "m3",
			reference: undefined,
			attachments: [],
		});
		const result = await collectPiAttachments(message, dir, {
			prepareImage: async () => {
				throw new Error("No images");
			},
		});
		expect(result.failures).toEqual([]);
		expect(lstatSync(dir).isDirectory()).toBe(true);
		expect(readdirSync(outside)).toEqual([]);
	} finally {
		rmSync(root, { recursive: true, force: true });
		rmSync(outside, { recursive: true, force: true });
	}
});
