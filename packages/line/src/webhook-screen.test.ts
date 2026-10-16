import { afterAll, beforeEach, expect, test } from "bun:test";
import type { SQL } from "bun";
import { describeDb, recordingLogger } from "pi-roundtable/testing";
import type { ParsedEvent } from "./events.ts";
import type { LineScreen, LineScreenVerdict } from "./screen.ts";
import {
	BOT,
	body,
	CHANNEL_ID,
	fakeLine,
	GROUP,
	messageEvent,
	SECRET,
	sign,
	webhookRequest,
} from "./testing/line-fake.ts";
import { freshPool } from "./testing/pool.ts";
import { TokenSource } from "./token.ts";
import { WebhookStats, webhookHandler } from "./webhook.ts";

const MAX = 1024;

describeDb("the webhook's screen", () => {
	let sql: SQL;
	let stored = 0;
	let bot: string | undefined = BOT;
	const logs = recordingLogger();
	const tokens = new TokenSource({
		credentials: { channelId: CHANNEL_ID, channelSecret: SECRET },
		fetch: fakeLine().fetch,
	});
	const time = new Date("2026-10-13T00:00:00Z");
	const handler = (
		options: {
			screen?: LineScreen;
			stats?: WebhookStats;
			maxBytes?: number;
		} = {},
	) =>
		webhookHandler({
			sql,
			tokens,
			logger: logs.logger,
			now: () => time,
			botUserId: () => bot,
			stats: options.stats ?? new WebhookStats(),
			stored: () => {
				stored++;
			},
			...(options.maxBytes ? { maxBytes: options.maxBytes } : {}),
			...(options.screen ? { screen: () => options.screen } : {}),
		});

	beforeEach(async () => {
		sql ??= await freshPool();
		await sql`TRUNCATE line_inbox, line_sources`;
		stored = 0;
		bot = BOT;
		logs.lines.length = 0;
		// The chat is allowed, so a kept event is stored whole.
		await handler()(webhookRequest(body(messageEvent({ id: "seed" }))));
		await sql`UPDATE line_sources SET status = 'allowed' WHERE source_key = ${GROUP}`;
		await sql`TRUNCATE line_inbox`;
		stored = 0;
		logs.lines.length = 0;
	});
	afterAll(async () => {
		await sql?.close();
	});

	const ids = async (): Promise<string[]> =>
		(await sql`SELECT webhook_event_id FROM line_inbox ORDER BY seq`).map(
			(row: { webhook_event_id: string }) => row.webhook_event_id,
		);
	const consuming =
		(...consumed: string[]): LineScreen =>
		async (event) =>
			consumed.includes(event.id) ? "consume" : "keep";

	test("a request that fails before its events are read never reaches the screen, and is answered and counted as without one", async () => {
		const asked: string[] = [];
		const screen: LineScreen = async (event) => {
			asked.push(event.id);
			return "consume";
		};
		const good = body(messageEvent({ id: "x" }));
		const other = JSON.stringify({
			destination: "Uanother-bot",
			events: [messageEvent({ id: "other" })],
		});
		const requests: (() => Request)[] = [
			() => webhookRequest(good, { signature: null }),
			() => webhookRequest(good, { signature: sign(good, "another-secret") }),
			() => webhookRequest(other),
			() => webhookRequest("not json"),
			() => webhookRequest('{"destination":"x"}'),
			() => webhookRequest("x".repeat(MAX + 1)),
			() => new Request("https://hook.example.test/line/webhook"),
		];
		const screened = new WebhookStats();
		const plain = new WebhookStats();
		for (const request of requests) {
			const withScreen = await handler({
				screen,
				stats: screened,
				maxBytes: MAX,
			})(request());
			const without = await handler({ stats: plain, maxBytes: MAX })(request());
			expect(withScreen.status).toBe(without.status);
		}
		expect(asked).toEqual([]);
		expect(screened.health().rejected).toEqual(plain.health().rejected);
		expect(screened.health().accepted).toBe(0);
		expect(await ids()).toEqual([]);
	});

	test("an empty events array (Verify) is a 200 and the screen is not asked", async () => {
		let asked = 0;
		const response = await handler({
			screen: async () => {
				asked++;
				return "keep";
			},
		})(webhookRequest(JSON.stringify({ destination: BOT, events: [] })));
		expect(response.status).toBe(200);
		expect(asked).toBe(0);
	});

	test("a kept event is stored as usual and a consumed one is not stored, whatever its neighbours do", async () => {
		const stats = new WebhookStats();
		const response = await handler({
			screen: consuming("b", "d"),
			stats,
		})(
			webhookRequest(
				body(
					messageEvent({ id: "a" }),
					messageEvent({ id: "b", text: "taken out" }),
					messageEvent({ id: "c" }),
					messageEvent({ id: "d", text: "taken out too" }),
				),
			),
		);
		expect(response.status).toBe(200);
		expect(await ids()).toEqual(["a", "c"]);
		expect(stored).toBe(1);
		expect(stats.health().accepted).toBe(1);
		const dump = JSON.stringify(await sql`SELECT * FROM line_inbox`);
		expect(dump).not.toContain("taken out");
		expect(dump).not.toContain("reply-b");
	});

	test("a request whose events are all consumed is a 200 that counts as accepted and leaves no trace, not even a pending chat", async () => {
		const stats = new WebhookStats();
		const response = await handler({ screen: consuming("a", "b"), stats })(
			webhookRequest(
				body(
					messageEvent({ id: "a" }),
					messageEvent({ id: "b", group: "Cgroup0009", text: "never seen" }),
				),
			),
		);
		expect(response.status).toBe(200);
		expect(stats.health()).toMatchObject({
			accepted: 1,
			rejected: { signature: 0, destination: 0, malformed: 0 },
		});
		expect(stored).toBe(0);
		expect(await ids()).toEqual([]);
		const keys = (await sql`SELECT source_key FROM line_sources`).map(
			(row: { source_key: string }) => row.source_key,
		);
		expect(keys).toEqual([GROUP]);
	});

	test("the screen is asked one event at a time, in the order of the request, with the event as LINE sent it", async () => {
		const events = [
			messageEvent({ id: "first", text: "one" }),
			{ ...messageEvent({ id: "second" }), mode: "standby" },
			{ type: "things", webhookEventId: "no-chat", timestamp: 1 },
			messageEvent({ id: "third", text: "three" }),
		];
		const seen: ParsedEvent[] = [];
		let running = 0;
		let overlap = false;
		await handler({
			screen: async (event) => {
				running++;
				if (running > 1) overlap = true;
				await Bun.sleep(5);
				seen.push(event);
				running--;
				return "keep";
			},
		})(webhookRequest(body(...events)));
		expect(overlap).toBe(false);
		expect(seen.map((event) => event.id)).toEqual([
			"first",
			"second",
			"no-chat",
			"third",
		]);
		expect(seen.map((event) => event.raw)).toEqual(events);
		expect(seen[0]).toMatchObject({
			type: "message",
			sourceKey: GROUP,
			active: true,
		});
		expect(seen[1]).toMatchObject({ active: false });
		expect(seen[2]).toMatchObject({ sourceKey: null });
	});

	test("a screen that throws fails the request with 500 and stores nothing, not even the events it had kept", async () => {
		const stats = new WebhookStats();
		const response = await handler({
			stats,
			screen: async (event) => {
				if (event.id === "boom")
					throw new Error("the code for staff is SECRET-WORDS");
				return "keep";
			},
		})(
			webhookRequest(
				body(
					messageEvent({ id: "fine", text: "words in flight" }),
					messageEvent({ id: "boom", text: "more words in flight" }),
				),
			),
		);
		expect(response.status).toBe(500);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(await ids()).toEqual([]);
		expect(stored).toBe(0);
		expect(stats.health().accepted).toBe(0);
		const line = logs.lines.find((l) => l.level === "error");
		expect(line?.fields.code).toBeString();
		const dump = JSON.stringify(logs.lines);
		for (const quoted of ["SECRET-WORDS", "words in flight", "boom"])
			expect(dump).not.toContain(quoted);
	});

	test("an answer other than keep or consume fails the request the same way", async () => {
		for (const verdict of [undefined, null, "KEEP", "drop", true, 1, {}]) {
			logs.lines.length = 0;
			const response = await handler({
				screen: async (event) =>
					event.id === "odd"
						? (verdict as unknown as LineScreenVerdict)
						: "keep",
			})(
				webhookRequest(
					body(
						messageEvent({ id: "ok", text: "words in flight" }),
						messageEvent({ id: "odd" }),
					),
				),
			);
			expect(response.status).toBe(500);
			expect(await ids()).toEqual([]);
			expect(logs.lines.find((l) => l.level === "error")?.fields.code).toBe(
				"screen_verdict_invalid",
			);
			expect(JSON.stringify(logs.lines)).not.toContain("words in flight");
		}
	});

	test("a screen that throws synchronously is a 500 too", async () => {
		const response = await handler({
			screen: (() => {
				throw new Error("not even a promise");
			}) as unknown as LineScreen,
		})(webhookRequest(body(messageEvent({ id: "a" }))));
		expect(response.status).toBe(500);
		expect(await ids()).toEqual([]);
	});
});
