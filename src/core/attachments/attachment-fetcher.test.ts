import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DEFAULT_IDLE_MS,
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
		// The code, not the message: an error's message may quote a path.
		expect(result.failures[0]?.reason).toBe("download failed: error");
		expect(result.files[0]?.contentType).toBe("text/plain");
		expect(await Bun.file(result.files[0]?.path ?? "").text()).toBe("hello");
	});
});

describe("attachment download limits", () => {
	test("a directory that cannot be made is a recorded failure, not a throw", async () => {
		const input = request();
		const blocker = join(input.dir, "file");
		await Bun.write(blocker, "x");
		const result = await fetchAttachments(
			{ ...input, dir: join(blocker, "inside") },
			fetcher(new Response("hello")),
		);
		expect(result.files).toEqual([]);
		expect(result.failures[0]?.reason).toBe("download failed: ENOTDIR");
		// The reason carries a code and never the directory that could not be made.
		for (const part of [input.dir, blocker, "inside"])
			expect(result.failures[0]?.reason).not.toContain(part);
	});

	test("an error that quotes a path is reported by its name or code only", async () => {
		const secret = "/srv/data/private-dir/attachments";
		const quoting = Object.assign(
			new Error(`EACCES: cannot write '${secret}'`),
			{
				code: "EACCES",
			},
		);
		const nameless = new Error(`failed at ${secret}`);
		for (const [error, expected] of [
			[quoting, "download failed: EACCES"],
			[nameless, "download failed: error"],
			[
				new DOMException(`gave up on ${secret}`, "TimeoutError"),
				"download failed: TimeoutError",
			],
		] as const) {
			const result = await fetchAttachments(
				request(),
				Object.assign(
					async () => {
						throw error;
					},
					{ preconnect: fetch.preconnect },
				),
			);
			expect(result.failures[0]?.reason).toBe(expected);
			expect(result.failures[0]?.reason).not.toContain(secret);
		}
	});

	test("an aborted signal fails the files still to come without fetching them", async () => {
		const controller = new AbortController();
		controller.abort();
		let calls = 0;
		const result = await fetchAttachments(
			{ ...request(), signal: controller.signal },
			Object.assign(
				async () => {
					calls += 1;
					return new Response("hello");
				},
				{ preconnect: fetch.preconnect },
			),
		);
		expect(calls).toBe(0);
		expect(result.failures[0]?.reason).toContain("download failed");
	});

	test("a body that stalls ends with the signal", async () => {
		const input = request();
		const stalled = new Response(new ReadableStream({ start() {} }));
		const started = Date.now();
		const result = await fetchAttachments(
			{ ...input, signal: AbortSignal.timeout(50) },
			fetcher(stalled),
		);
		expect(Date.now() - started).toBeLessThan(2_000);
		expect(result.files).toEqual([]);
		expect(result.failures[0]?.reason).toContain("download failed");
	});
});

describe("attachment idle timeout", () => {
	const second = {
		url: "https://example.test/second",
		name: "second.txt",
		size: 5,
		contentType: "text/plain",
	};
	const stalling = () =>
		new Response(
			new ReadableStream({
				start(controller) {
					controller.enqueue(new TextEncoder().encode("par"));
				},
			}),
		);

	test("the default is 10 seconds", () => {
		expect(DEFAULT_IDLE_MS).toBe(10_000);
	});

	test("a body that goes quiet is given up after idleMs, with no deadline signal at all, and the next file still downloads", async () => {
		const input = request();
		input.refs.push(second);
		let calls = 0;
		const started = Date.now();
		const result = await fetchAttachments(
			{ ...input, idleMs: 60 },
			Object.assign(
				async () => (++calls === 1 ? stalling() : new Response("hello")),
				{ preconnect: fetch.preconnect },
			),
		);
		expect(Date.now() - started).toBeLessThan(2_000);
		expect(result.failures).toEqual([
			{
				name: "file.bin",
				reason: "download failed: idle_timeout",
				fromReference: false,
			},
		]);
		expect(result.files.map((file) => file.name)).toEqual(["second.txt"]);
	});

	test("a fetch that never answers and ignores its signal is given up the same way", async () => {
		const input = request();
		const started = Date.now();
		const result = await fetchAttachments(
			{ ...input, idleMs: 60 },
			Object.assign(() => new Promise<Response>(() => {}), {
				preconnect: fetch.preconnect,
			}),
		);
		expect(Date.now() - started).toBeLessThan(2_000);
		expect(result.failures[0]?.reason).toBe("download failed: idle_timeout");
	});

	test("a slow body that keeps sending bytes is not idle, however long it takes", async () => {
		const input = request();
		let sent = 0;
		const slow = new Response(
			new ReadableStream<Uint8Array>({
				async pull(controller) {
					await Bun.sleep(40);
					controller.enqueue(new TextEncoder().encode("x"));
					if (++sent === 8) controller.close();
				},
			}),
		);
		const started = Date.now();
		const result = await fetchAttachments(
			{ ...input, idleMs: 120 },
			fetcher(slow),
		);
		expect(Date.now() - started).toBeGreaterThan(250);
		expect(result.failures).toEqual([]);
		expect(result.files[0]?.size).toBe(8);
	});

	test("the deadline still wins over a body that keeps sending, and is not called idle", async () => {
		const input = request();
		const endless = new Response(
			new ReadableStream<Uint8Array>({
				async pull(controller) {
					await Bun.sleep(10);
					controller.enqueue(new Uint8Array(1));
				},
			}),
		);
		const result = await fetchAttachments(
			{ ...input, idleMs: 1_000, signal: AbortSignal.timeout(80) },
			fetcher(endless),
		);
		expect(result.files).toEqual([]);
		expect(result.failures[0]?.reason).toBe("download failed: TimeoutError");
	});
});
