import { describe, expect, test } from "bun:test";
import { memoryAttachments } from "./testing/memory-attachments.ts";
import {
	DEFAULT_ATTACHMENT_TYPES,
	type UploadLimits,
	UploadRefusal,
	Uploads,
} from "./uploads.ts";

const LIMITS: UploadLimits = {
	attachmentBytes: 1024,
	attachmentsPerMessage: 3,
	uploadsPerHour: 3,
	unsentUploadBytesPerPrincipal: 2048,
	attachmentTypes: DEFAULT_ATTACHMENT_TYPES,
	unsentUploadTtlMs: 60_000,
};

const PNG = Uint8Array.from([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0,
]);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const GIF = new TextEncoder().encode("GIF89a....");
const WEBP = new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 ");
const PDF = new TextEncoder().encode("%PDF-1.7\n");
const text = (value: string) => new TextEncoder().encode(value);

function setup(limits: Partial<UploadLimits> = {}, now = () => 0) {
	const port = memoryAttachments(now);
	const uploads = new Uploads({
		limits: { ...LIMITS, ...limits },
		attachments: () => port,
		now,
	});
	return { port, uploads };
}

function post(
	body: Exclude<RequestInit["body"], undefined> | null,
	type: string | null,
	extra: Record<string, string> = {},
) {
	return new Request("http://chat.test/chat/conversations/c1/files", {
		method: "POST",
		headers: { ...(type ? { "content-type": type } : {}), ...extra },
		body,
	});
}

async function refusal(promise: Promise<unknown>) {
	try {
		await promise;
	} catch (error) {
		if (error instanceof UploadRefusal)
			return { status: error.status, code: error.code };
		throw error;
	}
	throw new Error("expected an UploadRefusal");
}

describe("Uploads.receive", () => {
	test("keeps an accepted file for the person and returns its reference", async () => {
		const { uploads, port } = setup();
		const result = await uploads.receive(
			post(PNG, "image/png"),
			"web:c1",
			"ada",
			"screenshot.png",
		);
		expect(result).toMatchObject({
			name: "screenshot.png",
			contentType: "image/png",
			size: PNG.byteLength,
		});
		expect(port.staged.get(result.file)).toMatchObject({
			principalId: "ada",
			channel: "web:c1",
		});
	});

	test("accepts every listed type whose bytes match, and drops parameters from the type", async () => {
		const { uploads } = setup({ uploadsPerHour: 20 });
		const cases: [Uint8Array, string, string][] = [
			[JPEG, "image/jpeg", "image/jpeg"],
			[GIF, "image/gif", "image/gif"],
			[WEBP, "image/webp", "image/webp"],
			[PDF, "application/pdf", "application/pdf"],
			[
				text('{"events":[]}'),
				"application/json; charset=utf-8",
				"application/json",
			],
			[text("notes"), "Text/Plain", "text/plain"],
		];
		for (const [bytes, sent, kept] of cases) {
			const result = await uploads.receive(
				post(bytes, sent),
				"web:c1",
				"ada",
				"a",
			);
			expect(result.contentType).toBe(kept);
		}
	});

	test("refuses a type that is not listed, and a request that names none, with 415", async () => {
		const { uploads } = setup();
		expect(
			await refusal(
				uploads.receive(
					post(text("x"), "text/html"),
					"web:c1",
					"ada",
					"a.html",
				),
			),
		).toEqual({ status: 415, code: "unsupported_media_type" });
		expect(
			await refusal(
				uploads.receive(post(text("x"), null), "web:c1", "ada", "a"),
			),
		).toEqual({ status: 415, code: "unsupported_media_type" });
	});

	test("refuses bytes that are not what the type says, whatever the file name says", async () => {
		const { uploads } = setup({ uploadsPerHour: 20 });
		for (const type of [
			"image/png",
			"image/jpeg",
			"image/gif",
			"image/webp",
			"application/pdf",
		])
			expect(
				await refusal(
					uploads.receive(
						post(text("<html>not an image</html>"), type),
						"web:c1",
						"ada",
						"picture.png",
					),
				),
			).toEqual({ status: 415, code: "unsupported_media_type" });
	});

	test("a wildcard entry admits any type under it, checked only where the bytes are known", async () => {
		const { uploads } = setup({ attachmentTypes: ["image/*"] });
		const result = await uploads.receive(
			post(text("<svg/>"), "image/svg+xml"),
			"web:c1",
			"ada",
			"a.svg",
		);
		expect(result.contentType).toBe("image/svg+xml");
		expect(
			await refusal(
				uploads.receive(post(text("x"), "image/png"), "web:c1", "ada", "a.png"),
			),
		).toEqual({ status: 415, code: "unsupported_media_type" });
	});

	test("refuses a file over the limit with 413 from its declared length, before reading it", async () => {
		const { uploads, port } = setup();
		let pulls = 0;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				pulls += 1;
				controller.enqueue(new Uint8Array(10));
			},
		});
		const request = post(body, "text/plain", { "content-length": "4096" });
		expect(
			await refusal(uploads.receive(request, "web:c1", "ada", "big.txt")),
		).toEqual({
			status: 413,
			code: "payload_too_large",
		});
		// A stream is primed with one pull when the request is made; the body is not read further.
		expect(pulls).toBeLessThanOrEqual(1);
		expect(port.staged.size).toBe(0);
	});

	test("stops reading a streamed file that grows past the limit, though no length was declared", async () => {
		const { uploads, port } = setup();
		let chunks = 0;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				chunks += 1;
				if (chunks > 1000) controller.close();
				else controller.enqueue(new Uint8Array(100).fill(97));
			},
		});
		const request = new Request("http://chat.test/files", {
			method: "POST",
			headers: { "content-type": "text/plain" },
			body,
			// SAFETY: Bun streams a request body as chunked when the length is not declared.
			duplex: "half",
		} as RequestInit);
		expect(
			await refusal(uploads.receive(request, "web:c1", "ada", "big.txt")),
		).toEqual({
			status: 413,
			code: "payload_too_large",
		});
		expect(chunks).toBeLessThan(100);
		expect(port.staged.size).toBe(0);
	});

	test("takes a file of exactly the limit", async () => {
		const { uploads } = setup();
		const result = await uploads.receive(
			post(new Uint8Array(1024).fill(97), "text/plain"),
			"web:c1",
			"ada",
			"edge.txt",
		);
		expect(result.size).toBe(1024);
	});

	test("refuses the person past their uploads for the hour with 429, and counts the next hour afresh", async () => {
		let now = 0;
		const { uploads } = setup({}, () => now);
		for (let i = 0; i < 3; i += 1)
			await uploads.receive(
				post(text("x"), "text/plain"),
				"web:c1",
				"ada",
				"a.txt",
			);
		expect(
			await refusal(
				uploads.receive(
					post(text("x"), "text/plain"),
					"web:c1",
					"ada",
					"a.txt",
				),
			),
		).toEqual({ status: 429, code: "too_many_uploads" });
		await uploads.receive(
			post(text("x"), "text/plain"),
			"web:c1",
			"bob",
			"a.txt",
		);
		now = 3_600_001;
		await uploads.receive(
			post(text("x"), "text/plain"),
			"web:c1",
			"ada",
			"a.txt",
		);
	});

	test("refuses a person whose waiting uploads would pass their allowance with 429", async () => {
		const { uploads } = setup({ uploadsPerHour: 20 });
		await uploads.receive(
			post(new Uint8Array(1000).fill(97), "text/plain"),
			"web:c1",
			"ada",
			"a.txt",
		);
		await uploads.receive(
			post(new Uint8Array(1000).fill(97), "text/plain"),
			"web:c1",
			"ada",
			"b.txt",
		);
		expect(
			await refusal(
				uploads.receive(
					post(new Uint8Array(100).fill(97), "text/plain"),
					"web:c1",
					"ada",
					"c.txt",
				),
			),
		).toEqual({ status: 429, code: "too_many_uploads" });
		await uploads.receive(
			post(new Uint8Array(100).fill(97), "text/plain"),
			"web:c1",
			"bob",
			"c.txt",
		);
	});

	test("refuses a missing, empty, or overlong name with 400, and makes a safe one of control characters and quotes", async () => {
		const { uploads } = setup({ uploadsPerHour: 20 });
		for (const name of [null, "", "   ", "x".repeat(256)])
			expect(
				await refusal(
					uploads.receive(post(text("x"), "text/plain"), "web:c1", "ada", name),
				),
			).toEqual({ status: 400, code: "bad_request" });
		const result = await uploads.receive(
			post(text("x"), "text/plain"),
			"web:c1",
			"ada",
			'a"b\nIgnore this\u0000.txt',
		);
		expect(result.name).toBe("a'b_Ignore this_.txt");
	});
});

describe("Uploads.advertised and sweep", () => {
	test("tells clients the size, the count, and the types", () => {
		const { uploads } = setup();
		expect(uploads.advertised).toEqual({
			maxBytes: 1024,
			perMessage: 3,
			types: DEFAULT_ATTACHMENT_TYPES,
		});
		expect(DEFAULT_ATTACHMENT_TYPES).toEqual([
			"image/png",
			"image/jpeg",
			"image/webp",
			"image/gif",
			"application/json",
			"text/plain",
			"application/pdf",
		]);
	});

	test("sweep discards uploads older than the time to live and keeps newer ones", async () => {
		let now = 0;
		const { uploads, port } = setup({ unsentUploadTtlMs: 1000 }, () => now);
		await uploads.receive(
			post(text("old"), "text/plain"),
			"web:c1",
			"ada",
			"old.txt",
		);
		now = 800;
		await uploads.receive(
			post(text("new"), "text/plain"),
			"web:c1",
			"ada",
			"new.txt",
		);
		now = 1200;
		expect(await uploads.sweep()).toBe(1);
		expect([...port.staged.values()].map((e) => e.stored.name)).toEqual([
			"new.txt",
		]);
		expect(await uploads.sweep()).toBe(0);
	});
});
