import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	fetchAttachments,
	MAX_ATTACHMENT_BYTES,
} from "./attachment-fetcher.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function request() {
	const dir = mkdtempSync(join(tmpdir(), "roundtable-fetch-"));
	dirs.push(dir);
	return {
		refs: [
			{
				url: "https://example.test/file",
				name: "file.bin",
				size: 1,
				contentType: "",
			},
		],
		dir,
		prefix: "message",
		fromReference: false,
	};
}

function streamingResponse(bytes: number, status = 200) {
	let pulled = 0;
	let cancelled = false;
	const chunk = new Uint8Array(1024 * 1024);
	const response = new Response(
		new ReadableStream<Uint8Array>(
			{
				pull(controller) {
					if (pulled >= bytes) {
						controller.close();
						return;
					}
					const size = Math.min(chunk.length, bytes - pulled);
					pulled += size;
					controller.enqueue(chunk.subarray(0, size));
				},
				cancel() {
					cancelled = true;
				},
			},
			{ highWaterMark: 0 },
		),
		{ status },
	);
	return { response, pulled: () => pulled, cancelled: () => cancelled };
}

// fetch.preconnect is not used by the downloader.
function fetcher(response: Response): typeof fetch {
	return Object.assign(async () => response, { preconnect: fetch.preconnect });
}

describe("attachment download resource use", () => {
	test("stops reading an oversized body as soon as it crosses the limit", async () => {
		const input = request();
		const source = streamingResponse(100 * 1024 * 1024);
		const result = await fetchAttachments(input, fetcher(source.response));
		expect(result.files).toEqual([]);
		expect(result.failures[0]?.reason).toContain("larger than 25 MB");
		expect(source.pulled()).toBeLessThanOrEqual(
			MAX_ATTACHMENT_BYTES + 1024 * 1024,
		);
		expect(source.cancelled()).toBe(true);
		expect(readdirSync(input.dir)).toEqual([]);
	});

	test("cancels an HTTP error body without downloading it", async () => {
		const source = streamingResponse(10 * 1024 * 1024, 503);
		const result = await fetchAttachments(request(), fetcher(source.response));
		expect(result.failures[0]?.reason).toContain("HTTP 503");
		expect(source.pulled()).toBe(0);
		expect(source.cancelled()).toBe(true);
	});

	test("accepts the exact size limit and preserves downloaded bytes", async () => {
		const input = request();
		const source = streamingResponse(MAX_ATTACHMENT_BYTES);
		const result = await fetchAttachments(input, fetcher(source.response));
		expect(result.failures).toEqual([]);
		expect(result.files[0]?.size).toBe(MAX_ATTACHMENT_BYTES);
		expect(Bun.file(result.files[0]?.path ?? "").size).toBe(
			MAX_ATTACHMENT_BYTES,
		);
	});

	test("continues after a stream failure and preserves metadata", async () => {
		const input = request();
		input.refs.push({
			url: "https://example.test/ok",
			name: "ok.txt",
			size: 5,
			contentType: "",
		});
		const broken = new Response(
			new ReadableStream({
				start(controller) {
					controller.error(new Error("connection lost"));
				},
			}),
		);
		let calls = 0;
		const result = await fetchAttachments(
			input,
			Object.assign(
				async () => {
					calls += 1;
					return calls === 1
						? broken
						: new Response("hello", {
								headers: { "content-type": "text/plain" },
							});
				},
				{ preconnect: fetch.preconnect },
			),
		);
		expect(result.failures[0]?.reason).toContain("connection lost");
		expect(result.files[0]?.contentType).toBe("text/plain");
		expect(await Bun.file(result.files[0]?.path ?? "").text()).toBe("hello");
	});
});
