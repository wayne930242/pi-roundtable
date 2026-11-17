import { describe, expect, test } from "bun:test";
import { fakeDiscord } from "../testing/fake-discord.ts";
import {
	type AttachmentFacts,
	AttachmentReadError,
	type AttachmentSource,
	discordAttachmentSource,
	readAttachment,
} from "./attachment-read.ts";

const CDN =
	"https://cdn.discordapp.com/attachments/7/11/report.pdf?ex=1&hm=sig";

const facts = (extra: Partial<AttachmentFacts> = {}): AttachmentFacts => ({
	id: "11",
	name: "report.pdf",
	contentType: "application/pdf",
	size: 5,
	url: CDN,
	title: "Q3",
	description: null,
	...extra,
});

/** A source over one message's files, recording what it was asked for. */
function source(files: AttachmentFacts[] | "none" = [facts()]) {
	const asked: string[] = [];
	const src: AttachmentSource = {
		files: async (channelId, messageId) => {
			asked.push(`${channelId}/${messageId}`);
			return files === "none" ? undefined : files;
		},
	};
	return { src, asked };
}

/** A CDN that serves `body` with `status`, recording the addresses it was asked for. */
function cdn(body: string | null = "hello", status = 200) {
	const fetched: string[] = [];
	const fetchImpl = (async (url: string) => {
		fetched.push(url);
		return new Response(body, { status });
	}) as unknown as typeof fetch;
	return { fetchImpl, fetched };
}

const request = { channelId: "7", messageId: "9", attachmentId: "11" };

async function code(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
		return "resolved";
	} catch (error) {
		if (error instanceof AttachmentReadError) return error.code;
		throw error;
	}
}

describe("readAttachment", () => {
	test("reads the file Discord describes now, from the address Discord gives, with its facts", async () => {
		const { src, asked } = source();
		const { fetchImpl, fetched } = cdn();
		const read = await readAttachment(src, request, {
			maxBytes: 100,
			fetchImpl,
		});
		expect(asked).toEqual(["7/9"]);
		expect(fetched).toEqual([CDN]);
		expect(read).toEqual({
			id: "11",
			name: "report.pdf",
			contentType: "application/pdf",
			size: 5,
			bytes: new TextEncoder().encode("hello"),
			title: "Q3",
		});
	});

	test("a message the bot cannot read, a file not on it, and an id that is no Discord id are not found", async () => {
		const { fetchImpl, fetched } = cdn();
		const options = { maxBytes: 100, fetchImpl };
		expect(
			await code(readAttachment(source("none").src, request, options)),
		).toBe("not-found");
		expect(
			await code(
				readAttachment(source([facts({ id: "12" })]).src, request, options),
			),
		).toBe("not-found");
		const { src, asked } = source();
		expect(
			await code(
				readAttachment(
					src,
					{ ...request, channelId: "https://evil.example/x" },
					options,
				),
			),
		).toBe("not-found");
		expect(asked).toEqual([]);
		expect(fetched).toEqual([]);
	});

	test("a file over the cap is refused before it is downloaded, and one that grows past it while downloading too", async () => {
		const big = cdn("x".repeat(50));
		expect(
			await code(
				readAttachment(source([facts({ size: 101 })]).src, request, {
					maxBytes: 100,
					fetchImpl: big.fetchImpl,
				}),
			),
		).toBe("too-large");
		expect(big.fetched).toEqual([]);
		// Discord said 5 bytes; 50 arrive, past a cap of 20 the call asked for.
		expect(
			await code(
				readAttachment(
					source().src,
					{ ...request, maxBytes: 20 },
					{ maxBytes: 100, fetchImpl: big.fetchImpl },
				),
			),
		).toBe("too-large");
	});

	test("a call may lower the host's cap, never raise it", async () => {
		const { fetchImpl } = cdn();
		expect(
			await code(
				readAttachment(
					source([facts({ size: 50 })]).src,
					{ ...request, maxBytes: 1_000 },
					{ maxBytes: 10, fetchImpl },
				),
			),
		).toBe("too-large");
	});

	test("a file the CDN no longer serves is gone; another failure is unavailable", async () => {
		for (const status of [403, 404, 410])
			expect(
				await code(
					readAttachment(source().src, request, {
						maxBytes: 100,
						fetchImpl: cdn(null, status).fetchImpl,
					}),
				),
			).toBe("gone");
		expect(
			await code(
				readAttachment(source().src, request, {
					maxBytes: 100,
					fetchImpl: cdn(null, 500).fetchImpl,
				}),
			),
		).toBe("unavailable");
		const failing: AttachmentSource = {
			files: async () => {
				throw new Error("Discord is not connected");
			},
		};
		expect(
			await code(
				readAttachment(failing, request, {
					maxBytes: 100,
					fetchImpl: cdn().fetchImpl,
				}),
			),
		).toBe("unavailable");
	});

	test("a download that takes too long is unavailable", async () => {
		const stalled = ((_url: string, init: { signal: AbortSignal }) =>
			new Promise((_resolve, reject) =>
				init.signal.addEventListener("abort", () => reject(init.signal.reason)),
			)) as unknown as typeof fetch;
		expect(
			await code(
				readAttachment(source().src, request, {
					maxBytes: 100,
					fetchImpl: stalled,
					timeoutMs: 20,
				}),
			),
		).toBe("unavailable");
	});

	test("an address off Discord's CDN is never fetched", async () => {
		for (const url of [
			"http://cdn.discordapp.com/a",
			"https://evil.example/a",
			"https://cdn.discordapp.com.evil.example/a",
			"not a url",
		]) {
			const { fetchImpl, fetched } = cdn();
			expect(
				await code(
					readAttachment(source([facts({ url })]).src, request, {
						maxBytes: 100,
						fetchImpl,
					}),
				),
			).toBe("unavailable");
			expect(fetched).toEqual([]);
		}
	});

	test("an error names the request and never the file's address", async () => {
		const error = await readAttachment(source().src, request, {
			maxBytes: 100,
			fetchImpl: cdn(null, 404).fetchImpl,
		}).then(
			() => new Error("resolved"),
			(e: unknown) => e as Error,
		);
		expect(error.message).toContain("attachment 11 of message 9 in channel 7");
		expect(error.message).not.toContain("cdn.discordapp.com");
	});
});

describe("discordAttachmentSource", () => {
	/** The parts of a discord.js client the source reads. */
	function client(found: (id: string) => unknown) {
		const calls: unknown[] = [];
		return {
			calls,
			client: {
				isReady: () => true,
				channels: {
					fetch: async (id: string) =>
						id === "7"
							? {
									isTextBased: () => true,
									messages: {
										fetch: async (options: unknown) => {
											calls.push(options);
											return found(id);
										},
									},
								}
							: null,
				},
			} as never,
		};
	}

	test("fetches the message from Discord, not the cache, and reads its files and a forward's", async () => {
		const own = facts();
		const forwarded = facts({ id: "12", name: "fwd.txt" });
		const { client: c, calls } = client(() => ({
			attachments: new Map([["11", own]]),
			messageSnapshots: new Map([
				["s", { attachments: new Map([["12", forwarded]]) }],
			]),
		}));
		expect(await discordAttachmentSource(c).files("7", "9")).toEqual([
			own,
			forwarded,
		]);
		expect(calls).toEqual([{ message: "9", force: true }]);
	});

	test("an unknown channel or message, or one the bot may not read, is none; another error throws", async () => {
		const missing = (code: number) =>
			client(() => {
				throw Object.assign(new Error("Discord says no"), { code });
			}).client;
		for (const code of [10003, 10008, 50001, 50013])
			expect(
				await discordAttachmentSource(missing(code)).files("7", "9"),
			).toBeUndefined();
		expect(
			await discordAttachmentSource(client(() => ({})).client).files("8", "9"),
		).toBeUndefined();
		await expect(
			discordAttachmentSource(missing(500)).files("7", "9"),
		).rejects.toThrow("Discord says no");
	});
});

describe("fakeDiscord's readAttachment", () => {
	test("serves its files with the real checks", async () => {
		const discord = fakeDiscord({
			attachments: [
				{
					channelId: "7",
					messageId: "9",
					id: "11",
					name: "notes.txt",
					contentType: "text/plain",
					bytes: "hi there",
				},
				{
					channelId: "7",
					messageId: "9",
					id: "12",
					name: "old",
					bytes: "x",
					gone: true,
				},
			],
			attachmentMaxBytes: 4,
		});
		const read = discord.service.given as {
			readAttachment: (r: typeof request & { maxBytes?: number }) => Promise<{
				bytes: Uint8Array;
			}>;
		};
		expect(await code(read.readAttachment(request))).toBe("too-large");
		expect(
			await code(read.readAttachment({ ...request, attachmentId: "12" })),
		).toBe("gone");
		expect(
			await code(read.readAttachment({ ...request, channelId: "8" })),
		).toBe("not-found");
		const roomy = fakeDiscord({
			attachments: [
				{ channelId: "7", messageId: "9", id: "11", name: "n", bytes: "hi" },
			],
		}).service.given as typeof read;
		expect(
			new TextDecoder().decode((await roomy.readAttachment(request)).bytes),
		).toBe("hi");
	});
});
