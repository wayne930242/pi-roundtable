import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeDb, silentLogger } from "pi-roundtable/testing";
import { WebSessions } from "../auth/sessions.ts";
import { type OutboxRow, PushOutbox } from "../push/outbox.ts";
import { loadVapid } from "../push/vapid.ts";
import {
	bootE,
	type EHost,
	MEL,
	ORIGIN,
	principalOf,
	rest,
} from "../testing/e-host.ts";
import { fakePushService, receiver } from "../testing/push.ts";
import {
	type PushTransport,
	runPushSender,
	webPushTransport,
	webSessionClaims,
	webSessionPrincipal,
} from "./index.ts";

const FCM = "https://fcm.googleapis.com/fcm/send/";

describeDb("the external push sender", () => {
	let app: EHost;
	let mel = "";
	let key: Awaited<ReturnType<typeof loadVapid>>;
	let vapidFile = "";
	const post = fakePushService();
	beforeAll(async () => {
		const keys = mkdtempSync(join(tmpdir(), "sender-keys-"));
		vapidFile = join(keys, "vapid.json");
		key = await loadVapid(vapidFile);
		app = await bootE({
			console: {
				push: {
					quietHours: false,
					tiers: ["owner", "member"],
					sender: { external: { publicKey: key.publicKey } },
				},
			},
		});
		mel = await principalOf(app.host, MEL);
		const sql = app.host.context.database();
		// The sessions table belongs to oidc sign-in; the sender reads it, so these tests make it.
		await WebSessions.migration.up(sql);
		await sql`DELETE FROM web_notice_recipients`;
		await sql`DELETE FROM web_notices`;
		await sql`DELETE FROM web_push_subscriptions`;
		await sql`DELETE FROM web_push_outbox`;
		await sql`DELETE FROM web_sessions`;
	}, 30_000);
	afterAll(async () => {
		const sql = app.host.context.database();
		await sql`DELETE FROM web_notice_recipients`;
		await sql`DELETE FROM web_notices`;
		await sql`DELETE FROM web_push_subscriptions`;
		await sql`DELETE FROM web_push_outbox`;
		await sql`DELETE FROM web_sessions`;
		await app.stop();
	});

	const sql = () => app.host.context.database();
	const logger = silentLogger();
	const subscribe = async (endpoint: string) => {
		const device = await receiver();
		const answer = await rest(app, "push/subscriptions", {
			method: "POST",
			who: "mel",
			body: JSON.stringify(device.subscription(endpoint, "Phone")),
		});
		expect(answer.status).toBe(200);
		return device;
	};

	test("the app never makes a VAPID key, and hands browsers the sender's public key", async () => {
		expect(existsSync(join(app.dataDir, "web", "vapid.json"))).toBe(false);
		const asked = await rest(app, "push/key", { who: "mel" });
		expect(((await asked.json()) as { key: string }).key).toBe(key.publicKey);
		const config = (await (
			await rest(app, "config", { who: "mel" })
		).json()) as {
			push?: { key?: string; tiers: string[] };
		};
		expect(config.push?.key).toBe(key.publicKey);
		expect(config.push?.tiers).toEqual(["owner", "member"]);
	});

	test("a notice is queued with no title or body, however long they are; the bell keeps them", async () => {
		await sql()`DELETE FROM web_push_outbox`;
		await subscribe(`${FCM}ext-1`);
		await app.app.notices.raise({
			tag: "t:ext",
			to: [mel],
			title: "A name the phone must not learn",
			body: "A message the phone must not learn",
			open: { page: "mailboxes", query: { box: "1" } },
			urgency: "normal",
			ackable: true,
		});
		const [row]: Record<string, unknown>[] =
			await sql()`SELECT * FROM web_push_outbox WHERE tag = 't:ext'`;
		expect(row).toMatchObject({
			kind: "notice",
			principal_id: mel,
			urgency: "normal",
			badge: 1,
			title: null,
			body: null,
			open: "/console/#/p/mailboxes?box=1",
		});
		const bell = (await (
			await rest(app, "notices", { who: "mel" })
		).json()) as {
			notices: { title: string }[];
		};
		expect(bell.notices[0]?.title).toContain("must not learn");
		await app.app.notices.resolve("t:ext", { reason: "end" });
	});

	test("a notice's via reaches the row, and a transport the sender does not have is refused at raise", async () => {
		await sql()`DELETE FROM web_push_outbox`;
		await expect(
			app.app.notices.raise({
				tag: "t:via",
				to: [mel],
				title: "x",
				urgency: "normal",
				via: ["slack"],
			}),
		).rejects.toThrow("slack");
		await app.app.notices.raise({
			tag: "t:via",
			to: [mel],
			title: "x",
			urgency: "normal",
			via: ["web-push"],
		});
		const [row]: { via: string[] | null }[] =
			await sql()`SELECT via FROM web_push_outbox WHERE tag = 't:via'`;
		expect(row?.via).toEqual(["web-push"]);
		await app.app.notices.resolve("t:via", { reason: "end" });
	});

	test("runPushSender sends what the app queued through the transports, in order, and records each try", async () => {
		await sql()`DELETE FROM web_push_outbox`;
		await app.app.notices.raise({
			tag: "t:run",
			to: [mel],
			title: "x",
			urgency: "high",
		});
		const tried: string[] = [];
		const first: PushTransport = {
			name: "first",
			send: async (row) => {
				tried.push(`first:${row.tag}`);
				return "skipped";
			},
		};
		const second: PushTransport = {
			name: "second",
			send: async (row, rendered) => {
				tried.push(`second:${rendered.title}`);
				return row.urgency === "high" ? "sent" : "failed";
			},
		};
		const third: PushTransport = {
			name: "third",
			send: async () => {
				tried.push("third");
				return "sent";
			},
		};
		const sender = runPushSender({
			database: sql(),
			transports: [first, second, third],
			render: (row: OutboxRow) => ({ title: `Words for ${row.kind}` }),
			logger,
			intervalMs: 20,
		});
		try {
			await sender.drain();
			expect(tried).toEqual(["first:t:run", "second:Words for notice"]);
			const deliveries: { transport: string; result: string }[] = await sql()`
				SELECT d.transport, d.result FROM web_push_deliveries d
				JOIN web_push_outbox o ON o.id = d.outbox_id WHERE o.tag = 't:run' ORDER BY d.at, d.transport`;
			expect(
				deliveries.map((d) => `${d.transport}:${d.result}`).sort(),
			).toEqual(["first:skipped", "second:sent"]);
			const [left]: { n: number }[] =
				await sql()`SELECT count(*)::int AS n FROM web_push_outbox WHERE done_at IS NULL`;
			expect(left?.n).toBe(0);
		} finally {
			await sender.stop();
		}
		await app.app.notices.resolve("t:run", { reason: "end" });
	});

	test("a row's via narrows the transports, and a transport that throws is a failed try, not a stopped sender", async () => {
		await sql()`DELETE FROM web_push_outbox`;
		const outbox = new PushOutbox(sql());
		const id = await outbox.enqueue({
			kind: "notice",
			tag: "t:narrow",
			principalId: mel,
			open: "/",
			urgency: "normal",
			badge: 0,
			via: ["b", "a"],
		});
		const tried: string[] = [];
		const make = (name: string, result: "sent" | "throw"): PushTransport => ({
			name,
			send: async () => {
				tried.push(name);
				if (result === "throw") throw new Error("down");
				return "sent";
			},
		});
		const sender = runPushSender({
			database: sql(),
			transports: [make("a", "sent"), make("b", "throw"), make("c", "sent")],
			render: () => ({ title: "x" }),
			logger,
			intervalMs: 20,
		});
		try {
			await sender.drain();
		} finally {
			await sender.stop();
		}
		// Only b and a, in the row's order; b threw, so a took it.
		expect(tried).toEqual(["b", "a"]);
		const results: { transport: string; result: string }[] =
			await sql()`SELECT transport, result FROM web_push_deliveries WHERE outbox_id = ${id} ORDER BY at, transport`;
		expect(results.map((r) => `${r.transport}:${r.result}`).sort()).toEqual([
			"a:sent",
			"b:failed",
		]);
	});

	test("the Web Push transport posts a sealed payload to each device, forgets one that is gone, and skips a person with none", async () => {
		await sql()`DELETE FROM web_push_subscriptions`;
		await sql()`DELETE FROM web_push_outbox`;
		const transport = webPushTransport({
			vapidFile,
			subject: "mailto:ops@example.test",
			database: sql(),
			fetch: post.fetch,
		});
		const row: OutboxRow = {
			id: 1,
			kind: "notice",
			tag: "t:wp",
			principalId: mel,
			open: "/console/#/room/x",
			urgency: "high",
			badge: 3,
			createdAt: new Date(),
		};
		const signal = AbortSignal.timeout(5000);
		expect(await transport.send(row, { title: "T" }, signal)).toBe("skipped");
		const live = await subscribe(`${FCM}wp-live`);
		await subscribe(`${FCM}wp-gone`);
		post.posts.length = 0;
		let goneStatus = 410;
		const mixed = webPushTransport({
			vapidFile,
			subject: "mailto:ops@example.test",
			database: sql(),
			fetch: (async (input: URL | string | Request, init?: RequestInit) => {
				const url = input instanceof Request ? input.url : String(input);
				post.posts.push({
					url,
					headers: new Headers(init?.headers),
					body: new Uint8Array(init?.body as ArrayBuffer),
				});
				return new Response(null, {
					status: url.endsWith("wp-gone") ? goneStatus : 201,
				});
			}) as typeof fetch,
		});
		expect(await mixed.send(row, { title: "T", body: "B" }, signal)).toBe(
			"sent",
		);
		const opened = (await live.open(
			post.posts.find((p) => p.url.endsWith("wp-live"))?.body ??
				new Uint8Array(),
		)) as Record<string, unknown>;
		expect(opened).toMatchObject({
			kind: "notice",
			title: "T",
			body: "B",
			tag: "t:wp",
			url: "/console/#/room/x",
			badge: 3,
			urgency: "high",
		});
		expect(post.posts.every((p) => p.headers.get("urgency") === "high")).toBe(
			true,
		);
		const left: { endpoint: string }[] =
			await sql()`SELECT endpoint FROM web_push_subscriptions`;
		expect(left.map((d) => d.endpoint)).toEqual([`${FCM}wp-live`]);
		// A transport that cannot read the key stops with the reason, never with a new key.
		const lost = webPushTransport({
			vapidFile: join(tmpdir(), "no-such-key.json"),
			subject: "mailto:ops@example.test",
			database: sql(),
			fetch: post.fetch,
		});
		await expect(lost.send(row, { title: "T" }, signal)).rejects.toThrow(
			"does not exist",
		);
		goneStatus = 201;
	});

	test("the subscribe endpoint takes the app's session cookie and its Origin, and nothing else", async () => {
		await sql()`DELETE FROM web_push_subscriptions`;
		const sessions = new WebSessions(sql(), { days: 30 });
		const made = await sessions.create(
			{
				provider: "oidc:x",
				subject: "mel",
				name: "Mel",
				claims: { mail: "mel@example.test" },
			},
			mel,
		);
		const sender = runPushSender({
			database: sql(),
			transports: [],
			render: () => ({ title: "x" }),
			logger,
			subscribe: {
				listener: { port: 0, hostname: "127.0.0.1" },
				path: "/push/subscriptions",
				origin: ORIGIN,
				authenticate: webSessionPrincipal({ database: sql() }),
			},
		});
		try {
			const port = sender.port;
			expect(port).toBeGreaterThan(0);
			const call = (
				init: RequestInit & { cookie?: string; origin?: string | null },
			) => {
				const { cookie, origin, ...more } = init;
				return fetch(`http://127.0.0.1:${port}/push/subscriptions`, {
					...more,
					headers: {
						...(cookie ? { cookie } : {}),
						...(origin ? { origin } : {}),
						...(more.body ? { "content-type": "application/json" } : {}),
					},
				});
			};
			const cookie = `__Secure-rt_session=${made.token}`;
			const device = await receiver();
			const body = JSON.stringify(device.subscription(`${FCM}sub-1`, "Phone"));
			expect(
				(await call({ method: "POST", body, origin: ORIGIN })).status,
			).toBe(401);
			expect((await call({ method: "POST", body, cookie })).status).toBe(403);
			expect(
				(
					await call({
						method: "POST",
						body,
						cookie,
						origin: "https://evil.example",
					})
				).status,
			).toBe(403);
			expect(
				(await call({ method: "POST", body, cookie, origin: ORIGIN })).status,
			).toBe(200);
			const listed = (await (await call({ cookie })).json()) as {
				devices: unknown[];
			};
			expect(listed.devices).toHaveLength(1);
			// A session past its limit is refused.
			await sql()`UPDATE web_sessions SET expires_at = now() - interval '1 minute'`;
			expect((await call({ cookie })).status).toBe(401);
			await sql()`UPDATE web_sessions SET expires_at = now() + interval '1 day'`;
			expect((await call({ cookie })).status).toBe(200);
			// A disabled principal is refused.
			await sql()`UPDATE principals SET disabled_at = now() WHERE id = ${mel}`;
			try {
				expect((await call({ cookie })).status).toBe(401);
			} finally {
				await sql()`UPDATE principals SET disabled_at = NULL WHERE id = ${mel}`;
			}
			// Only the person's own devices: removing by endpoint works for them.
			expect(
				(
					await call({
						method: "DELETE",
						cookie,
						origin: ORIGIN,
						body: JSON.stringify({ endpoint: `${FCM}sub-1` }),
					})
				).status,
			).toBe(200);
			expect((await fetch(`http://127.0.0.1:${port}/other`)).status).toBe(404);
		} finally {
			await sender.stop();
		}
	});

	test("webSessionClaims gives the claims of the newest live session and nothing for a person with none", async () => {
		const sessions = new WebSessions(sql(), { days: 30 });
		await sql()`DELETE FROM web_sessions`;
		expect(await webSessionClaims(sql(), mel)).toBeUndefined();
		await sessions.create(
			{
				provider: "oidc:x",
				subject: "mel",
				name: "Mel",
				claims: { mail: "old@example.test" },
			},
			mel,
		);
		await Bun.sleep(5);
		await sessions.create(
			{
				provider: "oidc:x",
				subject: "mel",
				name: "Mel",
				claims: { mail: "new@example.test" },
			},
			mel,
		);
		expect(await webSessionClaims(sql(), mel)).toEqual({
			mail: "new@example.test",
		});
		await sql()`UPDATE web_sessions SET expires_at = now() - interval '1 minute'`;
		expect(await webSessionClaims(sql(), mel)).toBeUndefined();
	});
});

describeDb(
	"an external sender and a key file left in the data directory",
	() => {
		test("the app refuses to start and names the file", async () => {
			const dir = mkdtempSync(join(tmpdir(), "sender-left-"));
			mkdirSync(join(dir, "web"), { recursive: true });
			writeFileSync(join(dir, "web", "vapid.json"), "{}");
			const keys = await loadVapid(
				join(mkdtempSync(join(tmpdir(), "sender-k-")), "v.json"),
			);
			await expect(
				bootE({
					dataDir: dir,
					console: {
						push: { sender: { external: { publicKey: keys.publicKey } } },
					},
				}),
			).rejects.toThrow(join(dir, "web", "vapid.json"));
		});
	},
);
