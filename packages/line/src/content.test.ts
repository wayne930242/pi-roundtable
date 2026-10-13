import { afterAll, beforeEach, expect, test } from "bun:test";
import type { SQL } from "bun";
import { describeDb } from "pi-roundtable/testing";
import { LineApi } from "./api.ts";
import { MessageContent } from "./content.ts";
import {
	CHANNEL_ID,
	type FakeLine,
	fakeLine,
	GROUP,
	SECRET,
} from "./testing/line-fake.ts";
import { freshPool, truncateAll } from "./testing/pool.ts";
import { TokenSource } from "./token.ts";

const bytes = (length: number, fill = 7) => new Uint8Array(length).fill(fill);

describeDb("message content", () => {
	let sql: SQL;
	let fake: FakeLine;
	let content: MessageContent;

	const build = (
		options: ConstructorParameters<typeof MessageContent>[2] = {},
	) => {
		fake = fakeLine();
		const tokens = new TokenSource({
			credentials: { channelId: CHANNEL_ID, channelSecret: SECRET },
			fetch: fake.fetch,
		});
		content = new MessageContent(
			sql,
			new LineApi({ tokens, fetch: fake.fetch }),
			{
				maxBytes: 1000,
				transcodingPollMs: 2,
				transcodingMaxMs: 20,
				...options,
			},
		);
	};
	const contentCalls = () =>
		fake.calls.filter((c) => c.url.includes("/message/"));

	beforeEach(async () => {
		sql ??= await freshPool();
		await truncateAll(sql);
		build();
	});
	afterAll(async () => {
		await sql?.close();
	});

	test("an image comes back as bytes and a content type, fetched from the data host with the token", async () => {
		fake.contents.m1 = {
			bytes: bytes(300),
			contentType: "image/jpeg; charset=binary",
		};
		const result = await content.fetch("m1", { kind: "image" });
		expect(result).toEqual({ bytes: bytes(300), contentType: "image/jpeg" });
		const [call] = contentCalls();
		expect(call?.url).toBe(
			"https://api-data.line.me/v2/bot/message/m1/content",
		);
		expect(call?.authorization).toBe("Bearer access-token-1");
	});

	test("content at the cap is kept, one byte over is too large, whether or not the length is declared", async () => {
		fake.contents.fits = { bytes: bytes(1000) };
		expect(await content.fetch("fits")).toMatchObject({
			contentType: "application/octet-stream",
		});
		fake.contents.big = { bytes: bytes(1001) };
		expect(await content.fetch("big")).toEqual({ tooLarge: true });
		// No content-length: the body is counted as it streams and dropped past the cap.
		fake.contents.streamed = { bytes: bytes(5000), streamChunk: 400 };
		expect(await content.fetch("streamed")).toEqual({ tooLarge: true });
		fake.contents.streamedOk = {
			bytes: bytes(900),
			streamChunk: 400,
			contentType: "audio/m4a",
		};
		expect(await content.fetch("streamedOk")).toEqual({
			bytes: bytes(900),
			contentType: "audio/m4a",
		});
	});

	test("content LINE no longer has is expired, not an error", async () => {
		expect(await content.fetch("gone")).toEqual({
			expired: true,
			reason: "expired",
		});
		fake.contents.null = null;
		expect(await content.fetch("null")).toEqual({
			expired: true,
			reason: "expired",
		});
	});

	test("a video is waited for until LINE has transcoded it, then fetched", async () => {
		fake.contents.v1 = { bytes: bytes(100), contentType: "video/mp4" };
		fake.transcoding.v1 = ["processing", "processing", "succeeded"];
		expect(await content.fetch("v1", { kind: "video" })).toEqual({
			bytes: bytes(100),
			contentType: "video/mp4",
		});
		const paths = contentCalls().map((c) => new URL(c.url).pathname);
		expect(paths).toEqual([
			"/v2/bot/message/v1/content/transcoding",
			"/v2/bot/message/v1/content/transcoding",
			"/v2/bot/message/v1/content/transcoding",
			"/v2/bot/message/v1/content",
		]);
		// Audio takes the same path; an image is not looked up at all.
		fake.contents.a1 = { bytes: bytes(10) };
		fake.transcoding.a1 = ["succeeded"];
		await content.fetch("a1", { kind: "audio" });
		fake.contents.i1 = { bytes: bytes(10) };
		fake.calls.length = 0;
		await content.fetch("i1", { kind: "image" });
		expect(contentCalls().map((c) => new URL(c.url).pathname)).toEqual([
			"/v2/bot/message/i1/content",
		]);
	});

	test("a transcoding that failed is expired with its reason, and one that never ends is a coded error", async () => {
		fake.contents.v2 = { bytes: bytes(10) };
		fake.transcoding.v2 = ["processing", "failed"];
		expect(await content.fetch("v2", { kind: "video" })).toEqual({
			expired: true,
			reason: "transcoding_failed",
		});
		fake.transcoding.v3 = ["processing"];
		await expect(content.fetch("v3", { kind: "video" })).rejects.toMatchObject({
			code: "transcoding_timeout",
		});
		// A video LINE does not know is expired.
		expect(await content.fetch("v4", { kind: "video" })).toEqual({
			expired: true,
			reason: "expired",
		});
	});

	test("an abort stops a download, and a wait for transcoding, with the signal's own reason", async () => {
		fake.hang.add("slow");
		const controller = new AbortController();
		const pending = content.fetch("slow", { signal: controller.signal });
		await Bun.sleep(10);
		const reason = new Error("handler gave up");
		controller.abort(reason);
		await expect(pending).rejects.toBe(reason);

		fake.transcoding.v5 = ["processing"];
		const waiting = new AbortController();
		const wait = content.fetch("v5", { kind: "video", signal: waiting.signal });
		await Bun.sleep(5);
		waiting.abort(reason);
		await expect(wait).rejects.toBe(reason);

		// Already aborted: nothing is asked of LINE.
		fake.calls.length = 0;
		await expect(
			content.fetch("m1", { signal: AbortSignal.abort(reason) }),
		).rejects.toBe(reason);
		expect(contentCalls()).toEqual([]);
	});

	test("a 401 reissues the token once and the download goes on", async () => {
		fake.contents.m2 = { bytes: bytes(20), contentType: "image/png" };
		await content.fetch("m2");
		fake.revoke("access-token-1");
		expect(await content.fetch("m2")).toMatchObject({
			contentType: "image/png",
		});
		expect(fake.issued).toEqual(["access-token-1", "access-token-2"]);
	});

	test("a message that was unsent is not fetched at all", async () => {
		fake.contents.m3 = { bytes: bytes(20) };
		await sql`INSERT INTO line_tombstones (source_key, message_id, created_at) VALUES (${GROUP}, 'm3', now())`;
		expect(await content.fetch("m3")).toEqual({
			expired: true,
			reason: "unsent",
		});
		expect(contentCalls()).toEqual([]);
	});

	test("a message id that is not an id is refused before anything is asked of LINE", async () => {
		for (const id of ["", "a/b", "../x", "m1?x=1", "a".repeat(65)])
			await expect(content.fetch(id)).rejects.toMatchObject({
				code: "bad_message_id",
			});
		expect(fake.calls).toEqual([]);
	});

	test("an API failure names a status and no body, and the content is in no error", async () => {
		fake.contents.m4 = {
			bytes: new TextEncoder().encode("PRIVATE CUSTOMER BYTES"),
		};
		const failing = (async () =>
			new Response("PRIVATE CUSTOMER BYTES", {
				status: 500,
			})) as unknown as typeof fetch;
		const tokens = new TokenSource({
			credentials: { channelId: CHANNEL_ID, channelSecret: SECRET },
			fetch: fake.fetch,
		});
		const api = new LineApi({
			tokens,
			fetch: ((input, init) =>
				String(input).includes("/message/")
					? failing(input, init)
					: fake.fetch(input, init)) as typeof fetch,
		});
		const error = await new MessageContent(sql, api)
			.fetch("m4")
			.catch((e: unknown) => e);
		expect(error).toMatchObject({ code: "http_500", status: 500 });
		expect(String(error)).not.toContain("PRIVATE");
	});
});
