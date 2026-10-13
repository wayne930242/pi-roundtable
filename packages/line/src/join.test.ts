import { afterAll, beforeEach, expect, test } from "bun:test";
import type { SQL } from "bun";
import { describeDb, recordingLogger } from "pi-roundtable/testing";
import { LineApi } from "./api.ts";
import { LineConsumer } from "./consumer.ts";
import { parseWebhook } from "./events.ts";
import type { InboxEvent } from "./inbox.ts";
import { checkJoinNotice, digestOf, JoinNotifier } from "./join.ts";
import type { LineEvent } from "./messages.ts";
import { body, CHANNEL_ID, fakeLine, SECRET } from "./testing/line-fake.ts";
import { freshPool, truncateAll } from "./testing/pool.ts";
import { TokenSource } from "./token.ts";

// A made-up notice: two paragraphs and some non-ASCII, so the digest is over UTF-8 bytes.
const TEXT =
	"Welcome, everyone.\n\nA person answers here; an assistant only helps. Café ☕ 😀";
const DIGEST = digestOf(TEXT);
const TIME = new Date("2026-10-13T00:00:00Z");
const enc = (value: string) => new TextEncoder().encode(value);

const joinEvent = (id: string, replyToken?: string) => ({
	type: "join",
	mode: "active",
	timestamp: 1_700_000_000_000,
	webhookEventId: id,
	source: { type: "group", groupId: "Cgroup0001" },
	...(replyToken === undefined ? {} : { replyToken }),
});

test("the digest is the SHA-256 of the UTF-8 bytes, as 64 lower-case hex digits, and a malformed one is refused", () => {
	expect(DIGEST).toMatch(/^[0-9a-f]{64}$/);
	expect(digestOf("abc")).toBe(
		"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
	);
	expect(() => checkJoinNotice({ text: TEXT, sha256: DIGEST })).not.toThrow();
	for (const sha256 of [
		"",
		"abc",
		DIGEST.toUpperCase(),
		`${DIGEST}0`,
		DIGEST.slice(1),
		"g".repeat(64),
	])
		expect(() => checkJoinNotice({ text: TEXT, sha256 })).toThrow(
			"joinNotice.sha256",
		);
	expect(() => checkJoinNotice({ text: "", sha256: digestOf("") })).toThrow(
		"joinNotice.text",
	);
	const long = "x".repeat(5001);
	expect(() => checkJoinNotice({ text: long, sha256: digestOf(long) })).toThrow(
		"joinNotice.text",
	);
});

describeDb("the join notice", () => {
	let sql: SQL;
	let fake = fakeLine();
	const logs = recordingLogger();

	const api = () =>
		new LineApi({
			tokens: new TokenSource({
				credentials: { channelId: CHANNEL_ID, channelSecret: SECRET },
				fetch: fake.fetch,
			}),
			fetch: fake.fetch,
		});
	const notifier = (notice?: { text: string; sha256: string }) =>
		new JoinNotifier({
			sql,
			api: api(),
			logger: logs.logger,
			now: () => TIME,
			...(notice ? { notice } : {}),
		});
	const event = (id: string, token?: string) => ({
		id,
		payload: joinEvent(id, token) as Record<string, unknown>,
	});

	beforeEach(async () => {
		sql ??= await freshPool();
		await truncateAll(sql);
		fake = fakeLine();
		logs.lines.length = 0;
	});
	afterAll(async () => {
		await sql?.close();
	});

	test("with no notice configured nothing is sent and the notice is unconfirmed", async () => {
		expect(await notifier().send(event("a", "rt-a"))).toBe("unconfirmed");
		expect(fake.calls).toEqual([]);
		expect(await sql`SELECT 1 FROM line_notices`).toHaveLength(0);
	});

	test("a text whose digest matches goes out once, as a Reply with the event's token and the exact text", async () => {
		const joins = notifier({ text: TEXT, sha256: DIGEST });
		expect(joins.armed).toBe(true);
		expect(await joins.send(event("a", "rt-a"))).toBe("sent");
		expect(fake.replies).toHaveLength(1);
		expect(fake.replies[0]?.replyToken).toBe("rt-a");
		expect(fake.replies[0]?.messages).toEqual([{ type: "text", text: TEXT }]);
		// The bytes LINE got hash to the configured digest.
		expect(digestOf(String(fake.replies[0]?.messages[0]?.text))).toBe(DIGEST);
		expect(fake.pushes).toEqual([]);
		expect(Array.from(await sql`SELECT outcome FROM line_notices`)).toEqual([
			{ outcome: "sent" },
		]);
	});

	test("a text that is not the one its digest names is never sent, to any chat", async () => {
		for (const text of [
			`${TEXT} `,
			TEXT.replace("Welcome", "welcome"),
			"other",
		]) {
			const joins = notifier({ text, sha256: DIGEST });
			expect(joins.armed).toBe(false);
			expect(await joins.send(event("t", "rt-t"))).toBe("failed");
		}
		expect(fake.calls).toEqual([]);
		expect(logs.lines.filter((l) => l.level === "warn")).toHaveLength(3);
		expect(logs.lines[0]?.fields).toMatchObject({
			code: "join_notice_digest_mismatch",
		});
		expect(JSON.stringify(logs.lines)).not.toContain("Welcome");
	});

	test("a Reply LINE refuses, or one that lapsed, is failed, with no push in its place", async () => {
		const joins = notifier({ text: TEXT, sha256: DIGEST });
		fake.replyScript.push(400);
		expect(await joins.send(event("a", "rt-a"))).toBe("failed");
		fake.replyScript.push(500);
		expect(await joins.send(event("b", "rt-b"))).toBe("failed");
		expect(fake.replies.map((r) => r.status)).toEqual([400, 500]);
		expect(fake.pushes).toEqual([]);
		expect(fake.calls.filter((c) => c.url.endsWith("/push"))).toEqual([]);
		expect(
			logs.lines.filter((l) => l.level === "warn").map((l) => l.fields.code),
		).toEqual(["http_400", "http_500"]);
		expect(JSON.stringify(logs.lines)).not.toContain("rt-a");
		// No reply token at all.
		expect(
			await joins.send({ id: "c", payload: joinEvent("c", undefined) }),
		).toBe("failed");
		expect(fake.replies).toHaveLength(2);
	});

	test("a Reply that got no answer is unconfirmed and stays attempting; a join handed out again does not reply (R6-F003)", async () => {
		const joins = notifier({ text: TEXT, sha256: DIGEST });
		expect(await joins.send(event("a", "rt-a"))).toBe("sent");
		fake.breakNetwork(true);
		expect(await joins.send(event("n", "rt-n"))).toBe("unconfirmed");
		fake.breakNetwork(false);
		expect(
			(await sql`SELECT outcome FROM line_notices WHERE webhook_event_id = 'n'`)[0],
		).toMatchObject({ outcome: "attempting" });
		const replies = fake.replies.length;
		expect(await joins.send(event("n", "rt-n"))).toBe("unconfirmed");
		expect(fake.replies).toHaveLength(replies);
		expect(
			logs.lines.filter((l) => l.level === "warn").map((l) => l.fields.code),
		).toEqual(["api_unreachable"]);
	});

	test("a join handed out again does not reply twice: it learns the outcome, or unconfirmed when the first try was cut short", async () => {
		const joins = notifier({ text: TEXT, sha256: DIGEST });
		expect(await joins.send(event("a", "rt-a"))).toBe("sent");
		expect(await joins.send(event("a", "rt-a"))).toBe("sent");
		fake.replyScript.push(400);
		expect(await joins.send(event("b", "rt-b"))).toBe("failed");
		expect(await joins.send(event("b", "rt-b"))).toBe("failed");
		expect(fake.replies).toHaveLength(2);
		// A crash between the claim and the answer leaves "attempting": nobody knows if LINE got it.
		await sql`INSERT INTO line_notices (webhook_event_id, outcome, created_at) VALUES ('c', 'attempting', ${TIME})`;
		expect(await joins.send(event("c", "rt-c"))).toBe("unconfirmed");
		expect(fake.replies).toHaveLength(2);
	});

	test("through the consumer the subscriber hears joined with the truth, for a chat that is not on the allowlist too", async () => {
		const heard: LineEvent[] = [];
		const consumer = new LineConsumer({
			sql,
			logger: logs.logger,
			now: () => TIME,
			joins: notifier({ text: TEXT, sha256: DIGEST }),
		});
		const process = consumer.processorFor(async (e) => {
			heard.push(e);
			return undefined;
		});
		const run = async (raw: Record<string, unknown>) => {
			const [parsed] = (await parseWebhook(enc(body(raw)))).events;
			if (!parsed) throw new Error("no event");
			const inbox: InboxEvent = {
				id: parsed.id,
				type: parsed.type,
				sourceKey: parsed.sourceKey,
				messageId: parsed.messageId,
				timestamp: parsed.timestamp,
				payload: parsed.raw,
				attempt: 1,
			};
			return process(inbox, new AbortController().signal);
		};
		await run(joinEvent("j1", "rt-j1"));
		fake.replyScript.push(400);
		await run(joinEvent("j2", "rt-j2"));
		// A redelivery of j1 hears the same truth and does not reply again.
		await run(joinEvent("j1", "rt-j1"));
		expect(heard.map((e) => (e.type === "joined" ? e.notice : e.type))).toEqual(
			["sent", "failed", "sent"],
		);
		expect(fake.replies.map((r) => r.replyToken)).toEqual(["rt-j1", "rt-j2"]);
		// Without a notifier the notice is unconfirmed.
		heard.length = 0;
		const bare = new LineConsumer({
			sql,
			logger: logs.logger,
			now: () => TIME,
		});
		await bare.processorFor(async (e) => void heard.push(e))(
			{
				id: "j9",
				type: "join",
				sourceKey: "line:group:Cgroup0001",
				messageId: null,
				timestamp: 1,
				payload: joinEvent("j9"),
				attempt: 1,
			},
			new AbortController().signal,
		);
		expect(heard).toMatchObject([{ type: "joined", notice: "unconfirmed" }]);
	});
});
