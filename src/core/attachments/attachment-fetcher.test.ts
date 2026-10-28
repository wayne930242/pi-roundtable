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

describe("refs a surface reads itself", () => {
	const neverFetched = Object.assign(
		async () => {
			throw new Error("fetched over the network");
		},
		{ preconnect: fetch.preconnect },
	) as unknown as typeof fetch;

	test("a ref the surface reads is saved from its bytes and never fetched", async () => {
		const input = request();
		const asked: string[] = [];
		const result = await fetchAttachments(
			{
				...input,
				refs: [
					{
						url: "app-upload:u1",
						name: "note.txt",
						size: 5,
						contentType: "text/plain",
					},
				],
				read: (ref) => {
					asked.push(ref.url);
					return Promise.resolve(new TextEncoder().encode("hello"));
				},
			},
			neverFetched,
		);
		expect(asked).toEqual(["app-upload:u1"]);
		expect(result.failures).toEqual([]);
		expect(result.files).toHaveLength(1);
		expect(result.files[0]).toMatchObject({
			name: "note.txt",
			contentType: "text/plain",
			size: 5,
			fromReference: false,
		});
		expect(await Bun.file(result.files[0]?.path ?? "").text()).toBe("hello");
	});

	test("a read that fails fails the file and is not retried over the network", async () => {
		const input = request();
		const result = await fetchAttachments(
			{
				...input,
				read: () => Promise.reject(new Error("unknown upload")),
			},
			neverFetched,
		);
		expect(result.files).toEqual([]);
		expect(result.failures).toEqual([
			{
				name: "file.bin",
				reason: "download failed: error",
				fromReference: false,
			},
		]);
		expect(readdirSync(input.dir)).toEqual([]);
	});

	test("bytes over the limit are refused like a download's", async () => {
		const input = request();
		const result = await fetchAttachments(
			{
				...input,
				read: () => Promise.resolve(new Uint8Array(MAX_ATTACHMENT_BYTES + 1)),
			},
			neverFetched,
		);
		expect(result.files).toEqual([]);
		expect(result.failures[0]?.reason).toContain("larger than 25 MB");
	});

	test("a surface without a reader leaves the ref to be downloaded", async () => {
		const input = request();
		const result = await fetchAttachments(
			{ ...input, read: () => undefined },
			fetcher(new Response("body")),
		);
		expect(result.files).toHaveLength(1);
		expect(result.files[0]?.size).toBe(4);
	});
});

describe("attachments over the default limit", () => {
	const MIB = 1024 * 1024;
	const neverFetched: typeof fetch = Object.assign(
		async () => {
			throw new Error("fetched");
		},
		{ preconnect: fetch.preconnect },
	);

	/** A file of `size` bytes outside the store, with a known first and last byte. */
	async function sourceFile(size: number): Promise<string> {
		const dir = mkdtempSync(join(tmpdir(), "roundtable-source-"));
		dirs.push(dir);
		const path = join(dir, "big.bin");
		const data = new Uint8Array(size);
		data[0] = 7;
		data[size - 1] = 9;
		await Bun.write(path, data);
		return path;
	}

	test("a file handed by path is stored past 25 MiB when the surface allows it", async () => {
		const input = request();
		const path = await sourceFile(30 * MIB);
		const first = input.refs[0];
		if (!first) throw new Error("no ref");
		const result = await fetchAttachments(
			{
				...input,
				refs: [{ ...first, size: 30 * MIB }],
				maxBytes: 100 * MIB,
				read: () => Promise.resolve({ path }),
			},
			neverFetched,
		);
		expect(result.failures).toEqual([]);
		const stored = result.files[0];
		expect(stored?.size).toBe(30 * MIB);
		const copy = Bun.file(stored?.path ?? "");
		expect(copy.size).toBe(30 * MIB);
		const bytes = new Uint8Array(await copy.arrayBuffer());
		expect([bytes[0], bytes[30 * MIB - 1]]).toEqual([7, 9]);
		// The source stays where the surface keeps it.
		expect(await Bun.file(path).exists()).toBe(true);
	});

	test("the same file is refused with the default limit", async () => {
		const input = request();
		const path = await sourceFile(26 * MIB);
		const result = await fetchAttachments(
			{ ...input, read: () => Promise.resolve({ path }) },
			neverFetched,
		);
		expect(result.files).toEqual([]);
		expect(result.failures[0]?.reason).toBe(
			`larger than 25 MB (${26 * MIB} bytes)`,
		);
		expect(readdirSync(input.dir)).toEqual([]);
	});

	test("the refusal names the surface's own limit", async () => {
		const input = request();
		const path = await sourceFile(3 * MIB);
		const result = await fetchAttachments(
			{ ...input, maxBytes: 2 * MIB, read: () => Promise.resolve({ path }) },
			neverFetched,
		);
		expect(result.failures[0]?.reason).toBe(
			`larger than 2 MB (${3 * MIB} bytes)`,
		);
		expect(readdirSync(input.dir)).toEqual([]);
	});

	test("the size the ref reports is checked against the surface's limit", async () => {
		const input = request();
		const first = input.refs[0];
		if (!first) throw new Error("no ref");
		const result = await fetchAttachments(
			{
				...input,
				refs: [{ ...first, size: 101 * MIB }],
				maxBytes: 100 * MIB,
				read: () => Promise.reject(new Error("not read")),
			},
			neverFetched,
		);
		expect(result.failures[0]?.reason).toBe(
			`larger than 100 MB (${101 * MIB} bytes)`,
		);
	});

	test("a path that is not a file fails that file only", async () => {
		const input = request();
		const result = await fetchAttachments(
			{
				...input,
				read: () => Promise.resolve({ path: join(input.dir, "missing") }),
			},
			neverFetched,
		);
		expect(result.files).toEqual([]);
		expect(result.failures[0]?.reason).toBe("download failed: ENOENT");
		expect(readdirSync(input.dir)).toEqual([]);
	});

	test("a stream is stored as it comes and cut off at the limit", async () => {
		const input = request();
		const source = streamingResponse(5 * MIB);
		const result = await fetchAttachments(
			{
				...input,
				maxBytes: 2 * MIB,
				read: () => Promise.resolve(source.response.body as ReadableStream),
			},
			neverFetched,
		);
		expect(result.files).toEqual([]);
		expect(result.failures[0]?.reason).toContain("larger than 2 MB");
		expect(source.pulled()).toBeLessThanOrEqual(3 * MIB);
		expect(source.cancelled()).toBe(true);
		expect(readdirSync(input.dir)).toEqual([]);
	});

	test("a stream within the limit is stored", async () => {
		const input = request();
		const source = streamingResponse(3 * MIB);
		const result = await fetchAttachments(
			{
				...input,
				maxBytes: 4 * MIB,
				read: () => Promise.resolve(source.response.body as ReadableStream),
			},
			neverFetched,
		);
		expect(result.failures).toEqual([]);
		expect(Bun.file(result.files[0]?.path ?? "").size).toBe(3 * MIB);
	});

	test("a download is also held to the surface's limit", async () => {
		const input = request();
		const over = await fetchAttachments(
			{ ...input, maxBytes: 2 * MIB },
			fetcher(streamingResponse(3 * MIB).response),
		);
		expect(over.failures[0]?.reason).toContain("larger than 2 MB");
		const within = await fetchAttachments(
			{ ...input, maxBytes: 30 * MIB },
			fetcher(streamingResponse(26 * MIB).response),
		);
		expect(within.failures).toEqual([]);
		expect(within.files[0]?.size).toBe(26 * MIB);
	});

	test("a limit that is not a positive integer is a programming error", async () => {
		for (const maxBytes of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])
			await expect(
				fetchAttachments({ ...request(), maxBytes }, neverFetched),
			).rejects.toThrow("maxAttachmentBytes");
	});
});
