import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import type {
	ChatSurface,
	Contribution,
	InboundMessage,
	PluginContext,
	Service,
	ServiceKey,
} from "pi-roundtable";
import {
	describeDb,
	describeSurfaceContract,
	partial,
	recordingLogger,
} from "pi-roundtable/testing";
import { digestOf } from "./join.ts";
import type { LineEvent } from "./messages.ts";
import { line } from "./plugin.ts";
import { LINE, type LineBridgePort } from "./port.ts";
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
import { freshPool, truncateAll } from "./testing/pool.ts";

const credentials = { channelId: CHANNEL_ID, channelSecret: SECRET };

test("a configuration mistake throws when the plugin is made, before the host starts", () => {
	expect(() =>
		line({ credentials: { ...credentials, channelId: "x" } }),
	).toThrow("channelId");
	expect(() =>
		line({ credentials: { ...credentials, channelSecret: "" } }),
	).toThrow("channelSecret");
	expect(() => line({ credentials, webhookPath: "line/hook" })).toThrow(
		"webhookPath",
	);
	expect(() => line({ credentials, webhookPath: "/line/" })).toThrow(
		"webhookPath",
	);
	expect(() => line({ credentials, inbox: { maxAttempts: 0 } })).toThrow(
		"inbox.maxAttempts",
	);
	expect(() => line({ credentials, inbox: { nope: 1 } as never })).toThrow(
		"inbox.nope",
	);
	// A timer cannot hold more than 2_147_483_647 ms; past it a handler would time out at once.
	for (const key of ["maxHandleMs", "leaseMs", "pollMs"] as const)
		expect(() =>
			line({ credentials, inbox: { [key]: 2_147_483_648 } }),
		).toThrow(`inbox.${key}`);
	expect(() =>
		line({
			credentials,
			inbox: { maxHandleMs: 2_147_483_647, leaseMs: 2_147_483_647 },
		}),
	).not.toThrow();
	expect(() => line({ credentials, media: { maxBytes: 0 } })).toThrow(
		"media.maxBytes",
	);
	expect(() => line({ credentials, media: { nope: 1 } as never })).toThrow(
		"media.nope",
	);
	expect(() => line({ credentials, retention: { inboxMs: -1 } })).toThrow(
		"retention.inboxMs",
	);
	expect(() =>
		line({
			credentials,
			media: { maxBytes: 1024 },
			retention: { inboxMs: 1000, messagesMs: 1000, intervalMs: 1000 },
		}),
	).not.toThrow();
});

test("a join notice, quota, sender, outbox or icon mistake throws when the plugin is made", () => {
	const text = "A made-up notice.";
	const sha256 = digestOf(text);
	expect(() =>
		line({ credentials, joinNotice: { text, sha256 } }),
	).not.toThrow();
	// A malformed digest is refused; a well-formed one that does not match is let through (nothing is sent).
	for (const bad of ["", "abc", sha256.toUpperCase(), `${sha256}0`])
		expect(() =>
			line({ credentials, joinNotice: { text, sha256: bad } }),
		).toThrow("joinNotice.sha256");
	expect(() =>
		line({ credentials, joinNotice: { text, sha256: digestOf("other") } }),
	).not.toThrow();
	expect(() => line({ credentials, quota: { monthlyCap: 0 } })).toThrow(
		"quota.monthlyCap",
	);
	expect(() => line({ credentials, quota: { monthlyCap: 1.5 } })).toThrow(
		"quota.monthlyCap",
	);
	expect(() => line({ credentials, quota: { nope: 1 } as never })).toThrow(
		"quota.nope",
	);
	expect(() => line({ credentials, quota: { monthlyCap: 100 } })).not.toThrow();
	expect(() => line({ credentials, sender: { forbiddenWords: [""] } })).toThrow(
		"forbiddenWords",
	);
	expect(() => line({ credentials, outbox: { coalesceMs: -1 } })).toThrow(
		"outbox.coalesceMs",
	);
	expect(() => line({ credentials, outbox: { maxAttempts: 0 } })).toThrow(
		"outbox.maxAttempts",
	);
	expect(() => line({ credentials, outbox: { nope: 1 } as never })).toThrow(
		"outbox.nope",
	);
	expect(() => line({ credentials, outbox: { coalesceMs: 0 } })).not.toThrow();
	expect(() => line({ credentials, route: "yes" as never })).toThrow("route");
	const png = new Uint8Array([
		0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0,
	]);
	expect(() =>
		line({ credentials, senderIconRoute: { path: "/line/icon.png", png } }),
	).not.toThrow();
	expect(() =>
		line({ credentials, senderIconRoute: { path: "icon.png", png } }),
	).toThrow("senderIconRoute.path");
	expect(() =>
		line({ credentials, senderIconRoute: { path: "/line/webhook", png } }),
	).toThrow("differ from webhookPath");
	expect(() =>
		line({
			credentials,
			senderIconRoute: {
				path: "/line/icon.png",
				png: new Uint8Array([1, 2, 3]),
			},
		}),
	).toThrow("not a PNG");
	expect(() =>
		line({
			credentials,
			senderIconRoute: { path: "/line/icon.png", png: new Uint8Array(0) },
		}),
	).toThrow("senderIconRoute.png");
});

describeDb("the line plugin", () => {
	let sql: SQL;
	const time = new Date("2026-10-13T00:00:00Z");
	const logs = recordingLogger();
	let provided: unknown;
	/** The tests that need time to pass (the outbox's window) run on the real clock. */
	let realClock = false;

	const context = (): PluginContext =>
		partial<PluginContext>({
			logger: logs.logger,
			env: partial<PluginContext["env"]>({
				now: () => (realClock ? new Date() : time),
			}),
			database: () => sql,
			services: partial<PluginContext["services"]>({
				provide: <T>(key: ServiceKey<T>, value: T) => {
					expect(key.id).toBe(LINE.id);
					provided = value;
				},
			}),
		});
	const boot = async (options: Partial<Parameters<typeof line>[0]> = {}) => {
		const fake = fakeLine();
		const plugin = line({
			credentials,
			fetch: fake.fetch,
			inbox: { pollMs: 20 },
			...options,
		});
		const contribution: Contribution = await plugin.setup(context());
		const service = (name: string): Service => {
			const found = contribution.services?.find((s) => s.name === name);
			if (!found) throw new Error(`no service ${name}`);
			return found;
		};
		const route = contribution.http?.find((r) => r.name === "line-webhook");
		if (!route) throw new Error("no route");
		return {
			fake,
			plugin,
			contribution,
			service,
			route,
			port: provided as LineBridgePort,
		};
	};

	beforeEach(async () => {
		sql ??= await freshPool();
		await truncateAll(sql);
		logs.lines.length = 0;
		provided = undefined;
		realClock = false;
	});
	afterAll(async () => {
		await sql?.close();
	});

	test("it contributes the webhook route, the surface, four services and the LINE service, and declares its migration", async () => {
		const { plugin, contribution, route, port } = await boot();
		expect(plugin.name).toBe("line");
		expect(plugin.provides).toEqual([LINE]);
		expect(plugin.migrations?.map((m) => m.name)).toEqual([
			"inbox",
			"messages",
			"outbox",
		]);
		expect(contribution.services?.map((s) => s.name)).toEqual([
			"line-bot",
			"line-inbox",
			"line-outbox",
			"line-retention",
		]);
		expect(contribution.surfaces?.map((s) => s.surface)).toEqual(["line"]);
		// No icon route unless one is configured.
		expect(contribution.http?.map((r) => r.name)).toEqual(["line-webhook"]);
		expect(route).toMatchObject({
			name: "line-webhook",
			listener: "public",
			path: { exact: "/line/webhook" },
			methods: ["POST"],
		});
		expect(Object.keys(port).sort()).toEqual([
			"botUserId",
			"content",
			"health",
			"outbox",
			"sources",
			"subscribe",
		]);
		const custom = await boot({ webhookPath: "/hooks/line", listener: "edge" });
		expect(custom.route).toMatchObject({
			listener: "edge",
			path: { exact: "/hooks/line" },
		});
	});

	test("a signed event of an allowed chat travels webhook to inbox to the attached processor", async () => {
		const { fake, service, route, port } = await boot();
		await service("line-bot").startInBackground?.();
		expect(port.botUserId()).toBe(BOT);
		await service("line-inbox").start?.();
		const got: LineEvent[] = [];
		const detach = port.subscribe(async (event) => {
			got.push(event);
			return undefined;
		});
		expect(() => port.subscribe(async () => undefined)).toThrow(
			"already attached",
		);

		// The first message is from an unknown chat: pending, nothing kept.
		expect(
			(await route.handle(webhookRequest(body(messageEvent({ id: "m1" })))))
				.status,
		).toBe(200);
		expect((await port.sources.pending()).map((s) => s.key)).toEqual([GROUP]);
		await port.sources.allow(GROUP);
		const raw = body(messageEvent({ id: "m2", text: "second" }));
		expect((await route.handle(webhookRequest(raw))).status).toBe(200);
		// A forged signature does not get in.
		expect(
			(
				await route.handle(
					webhookRequest(raw, { signature: sign(raw, "other") }),
				)
			).status,
		).toBe(401);
		for (let i = 0; i < 400 && got.length < 1; i++) await Bun.sleep(10);
		expect(got).toEqual([
			{
				type: "message",
				eventId: "m2",
				sourceKey: GROUP,
				timestamp: 1_700_000_000_000,
				messageId: "m-m2",
				userId: "Uuser0001",
				body: { kind: "text", text: "second" },
			},
		]);
		expect(port.health()).toEqual({ tokensIssued: 1, tokenFailure: undefined });
		expect(fake.issued).toHaveLength(1);

		detach();
		await service("line-inbox").stop?.();
		expect(service("line-inbox").busy?.()).toEqual([]);
	});

	test("one subscriber at a time: a second is refused, detaching frees the place, and events wait while none is attached", async () => {
		const { service, route, port } = await boot();
		await service("line-inbox").start?.();
		await route.handle(webhookRequest(body(messageEvent({ id: "s0" }))));
		await port.sources.allow(GROUP);
		await route.handle(
			webhookRequest(body(messageEvent({ id: "s1", text: "waits" }))),
		);
		// Nobody is attached: the event waits with its payload and is not counted as handled.
		await Bun.sleep(80);
		const [waiting] =
			await sql`SELECT status, attempts, payload FROM line_inbox WHERE webhook_event_id = 's1'`;
		expect(waiting).toMatchObject({ status: "pending", attempts: 0 });
		expect(waiting.payload.message.text).toBe("waits");

		const first: LineEvent[] = [];
		const detach = port.subscribe(async (event) => {
			first.push(event);
		});
		expect(() => port.subscribe(async () => undefined)).toThrow(
			"already attached",
		);
		for (let i = 0; i < 400 && first.length < 1; i++) await Bun.sleep(10);
		expect(first.map((e) => e.type)).toEqual(["message"]);

		detach();
		detach();
		await route.handle(
			webhookRequest(body(messageEvent({ id: "s2", text: "after" }))),
		);
		await Bun.sleep(80);
		expect(first).toHaveLength(1);
		const second: LineEvent[] = [];
		port.subscribe(async (event) => {
			second.push(event);
		});
		for (let i = 0; i < 400 && second.length < 1; i++) await Bun.sleep(10);
		expect(second.map((e) => (e as { eventId: string }).eventId)).toEqual([
			"s2",
		]);
		await service("line-inbox").stop?.();
	});

	test("content comes through the service with the configured cap, and retention runs as a service", async () => {
		const { fake, service, port } = await boot({ media: { maxBytes: 50 } });
		fake.contents.pic = { bytes: new Uint8Array(40) };
		fake.contents.huge = { bytes: new Uint8Array(51) };
		expect(await port.content("pic", { kind: "image" })).toMatchObject({
			contentType: "application/octet-stream",
		});
		expect(await port.content("huge")).toEqual({ tooLarge: true });
		const retention = service("line-retention");
		await sql`INSERT INTO line_tombstones (source_key, message_id, created_at) VALUES (${GROUP}, 'old', ${new Date(time.getTime() - 8 * 86_400_000)})`;
		await retention.start?.();
		for (let i = 0; i < 200; i++) {
			const [row] = await sql`SELECT count(*)::int AS n FROM line_tombstones`;
			if (row.n === 0) break;
			await Bun.sleep(10);
		}
		await retention.stop?.();
		expect((await sql`SELECT 1 FROM line_tombstones`).length).toBe(0);
		expect(retention.busy?.()).toEqual([]);
	});

	test("the retention service hands the refs of an unsent message that nobody took back to the attached subscriber", async () => {
		const { service, port } = await boot();
		const old = new Date(time.getTime() - 60 * 60_000);
		await sql`INSERT INTO line_tombstones (source_key, message_id, created_at) VALUES (${GROUP}, 'gone', ${old})`;
		await sql`INSERT INTO line_message_refs (source_key, message_id, ref, position, created_at)
			VALUES (${GROUP}, 'gone', 'stray-post', 0, ${old})`;
		const heard: LineEvent[] = [];
		// Nobody is attached: the ref waits, and the sweep does not drop it for being old.
		const retention = service("line-retention");
		await retention.start?.();
		await Bun.sleep(100);
		await retention.stop?.();
		expect((await sql`SELECT 1 FROM line_message_refs`).length).toBe(1);

		port.subscribe(async (event) => {
			heard.push(event);
			return undefined;
		});
		await retention.start?.();
		for (let i = 0; i < 200 && heard.length === 0; i++) await Bun.sleep(10);
		await retention.stop?.();
		expect(heard).toMatchObject([
			{ type: "unsent", messageId: "gone", refs: ["stray-post"] },
		]);
		expect((await sql`SELECT 1 FROM line_message_refs`).length).toBe(0);
	});

	test("the token and the secret appear in no log line and no error, through a whole run and through failures", async () => {
		const { fake, service, route, port } = await boot();
		fake.failTokens(500);
		await service("line-bot").startInBackground?.();
		expect(port.botUserId()).toBeUndefined();
		expect(port.health().tokenFailure).toBe("token_refused");
		fake.failTokens(undefined);
		await service("line-bot").startInBackground?.();
		expect(port.botUserId()).toBe(BOT);
		fake.breakNetwork(true);
		const errors: string[] = [];
		await port.sources
			.summary(GROUP)
			.catch((e: unknown) => errors.push(String(e)));
		fake.breakNetwork(false);
		await route.handle(webhookRequest(body(messageEvent({ id: "m1" }))));
		await route.handle(webhookRequest("{}", { signature: "bad" }));
		await route.handle(webhookRequest("not json"));
		const secrets = [SECRET, ...fake.issued, "access-token-"];
		const everything =
			JSON.stringify(logs.lines) + errors.join("\n") + JSON.stringify(port);
		for (const secret of secrets) expect(everything).not.toContain(secret);
		// There were lines to look at.
		expect(logs.lines.length).toBeGreaterThan(3);
		expect(logs.lines.some((l) => l.fields.code === "token_refused")).toBe(
			true,
		);
	});

	/** Waits until `done` holds, polling the real clock. */
	const until = async (done: () => boolean | Promise<boolean>, turns = 600) => {
		for (let i = 0; i < turns && !(await done()); i++) await Bun.sleep(10);
	};
	const FAST = {
		outbox: { coalesceMs: 20, pollMs: 10 },
		inbox: { pollMs: 10 },
	};

	test("a push queued through the service goes out under its sender and key, and the subscriber hears how it ended", async () => {
		realClock = true;
		const { fake, service, route, port } = await boot(FAST);
		await route.handle(webhookRequest(body(messageEvent({ id: "o0" }))));
		await port.sources.allow(GROUP);
		const heard: LineEvent[] = [];
		port.subscribe(async (event) => {
			heard.push(event);
			return undefined;
		});
		await service("line-inbox").start?.();
		await service("line-outbox").start?.();
		const sender = {
			name: "Ada｜Support",
			iconUrl: "https://icons.example.test/staff.png",
		};
		await port.outbox.enqueue(GROUP, [{ type: "text", text: "one" }], {
			sender,
			origin: "draft-1",
		});
		await port.outbox.enqueue(GROUP, [{ type: "text", text: "two" }], {
			sender,
			origin: "draft-1",
		});
		await until(() => heard.some((e) => e.type === "outboxResult"));
		expect(fake.pushes).toHaveLength(1);
		expect(fake.pushes[0]?.to).toBe("Cgroup0001");
		expect(fake.pushes[0]?.messages).toEqual([
			{ type: "text", text: "one", sender },
			{ type: "text", text: "two", sender },
		]);
		expect(fake.pushes[0]?.retryKey).toMatch(/^[0-9a-f-]{36}$/);
		expect(heard.filter((e) => e.type === "outboxResult")).toEqual([
			{
				type: "outboxResult",
				sourceKey: GROUP,
				originRef: "draft-1",
				status: "sent",
				errorCode: null,
			},
		]);
		// A sender LINE would refuse never reaches the queue.
		await expect(
			port.outbox.enqueue(GROUP, [{ type: "text", text: "x" }], {
				sender: { name: "LINE desk" },
			}),
		).rejects.toMatchObject({ code: "bad_sender" });
		expect(fake.pushes).toHaveLength(1);
		await service("line-inbox").stop?.();
		await service("line-outbox").stop?.();
		expect(service("line-outbox").busy?.()).toEqual([]);
	});

	describe("the join notice", () => {
		const TEXT = "A made-up notice for tests.\n\nNothing here is real.";
		const joinRaw = (id: string) =>
			JSON.stringify({
				destination: BOT,
				events: [
					{
						type: "join",
						mode: "active",
						timestamp: 1_700_000_000_000,
						webhookEventId: id,
						source: { type: "group", groupId: "Cgroup0009" },
						replyToken: `rt-${id}`,
					},
				],
			});

		test("a group that is not on the allowlist is answered once with the confirmed text, and the subscriber hears sent", async () => {
			realClock = true;
			const { fake, service, route, port } = await boot({
				...FAST,
				joinNotice: { text: TEXT, sha256: digestOf(TEXT) },
			});
			const heard: LineEvent[] = [];
			port.subscribe(async (event) => {
				heard.push(event);
				return undefined;
			});
			await service("line-inbox").start?.();
			expect((await route.handle(webhookRequest(joinRaw("j1")))).status).toBe(
				200,
			);
			await until(() => heard.length > 0);
			expect(heard).toMatchObject([
				{ type: "joined", sourceKey: "line:group:Cgroup0009", notice: "sent" },
			]);
			expect(fake.replies).toEqual([
				{
					replyToken: "rt-j1",
					messages: [{ type: "text", text: TEXT }],
					status: 200,
				},
			]);
			expect(fake.pushes).toEqual([]);
			expect((await port.sources.pending()).map((s) => s.key)).toContain(
				"line:group:Cgroup0009",
			);
			await service("line-inbox").stop?.();
		});

		test("a tampered text sends nothing and the subscriber hears failed; a refused Reply is failed too, with no push", async () => {
			realClock = true;
			const { fake, service, route, port } = await boot({
				...FAST,
				joinNotice: { text: `${TEXT} edited`, sha256: digestOf(TEXT) },
			});
			const heard: LineEvent[] = [];
			port.subscribe(async (event) => {
				heard.push(event);
				return undefined;
			});
			await service("line-inbox").start?.();
			await route.handle(webhookRequest(joinRaw("j2")));
			await until(() => heard.length > 0);
			expect(heard).toMatchObject([{ type: "joined", notice: "failed" }]);
			expect(fake.calls.filter((c) => /reply|push/.test(c.url))).toEqual([]);
			expect(
				logs.lines.some((l) => l.fields.code === "join_notice_digest_mismatch"),
			).toBe(true);
			await service("line-inbox").stop?.();

			const ok = await boot({
				...FAST,
				joinNotice: { text: TEXT, sha256: digestOf(TEXT) },
			});
			ok.fake.replyScript.push(400);
			const again: LineEvent[] = [];
			ok.port.subscribe(async (event) => {
				again.push(event);
				return undefined;
			});
			await sql`TRUNCATE line_inbox, line_notices`;
			await ok.service("line-inbox").start?.();
			await ok.route.handle(webhookRequest(joinRaw("j3")));
			await until(() => again.length > 0);
			expect(again).toMatchObject([{ type: "joined", notice: "failed" }]);
			expect(ok.fake.replies).toHaveLength(1);
			expect(ok.fake.pushes).toEqual([]);
			await ok.service("line-inbox").stop?.();
		});

		test("with no notice configured nothing is ever sent and the subscriber hears unconfirmed", async () => {
			realClock = true;
			const { fake, service, route, port } = await boot(FAST);
			const heard: LineEvent[] = [];
			port.subscribe(async (event) => {
				heard.push(event);
				return undefined;
			});
			await service("line-inbox").start?.();
			await route.handle(webhookRequest(joinRaw("j4")));
			await until(() => heard.length > 0);
			expect(heard).toMatchObject([{ type: "joined", notice: "unconfirmed" }]);
			expect(fake.calls.filter((c) => /reply|push/.test(c.url))).toEqual([]);
			await service("line-inbox").stop?.();
		});
	});

	describe("router delivery", () => {
		const started = async (contribution: Contribution) => {
			const surface = contribution.surfaces?.[0] as ChatSurface;
			const delivered: InboundMessage[] = [];
			await surface.start((message) => void delivered.push(message));
			return delivered;
		};

		test("is off by default: text of an allowed chat reaches the subscriber and never the router", async () => {
			realClock = true;
			const { contribution, service, route, port } = await boot(FAST);
			const delivered = await started(contribution);
			const heard: LineEvent[] = [];
			port.subscribe(async (event) => {
				heard.push(event);
				return undefined;
			});
			await route.handle(webhookRequest(body(messageEvent({ id: "r0" }))));
			await port.sources.allow(GROUP);
			await service("line-inbox").start?.();
			await route.handle(
				webhookRequest(body(messageEvent({ id: "r1", text: "hello" }))),
			);
			await until(() => heard.length > 0);
			await Bun.sleep(50);
			expect(heard).toHaveLength(1);
			expect(delivered).toEqual([]);
			await service("line-inbox").stop?.();
		});

		test("when on, text of an allowed chat reaches the router even with no subscriber, and a chat that is not allowed never does", async () => {
			realClock = true;
			const { contribution, service, route, port } = await boot({
				...FAST,
				route: true,
			});
			const delivered = await started(contribution);
			await route.handle(webhookRequest(body(messageEvent({ id: "r0" }))));
			await service("line-inbox").start?.();
			// Still pending: nothing is kept or routed.
			await route.handle(
				webhookRequest(body(messageEvent({ id: "r1", text: "ignored" }))),
			);
			await Bun.sleep(80);
			expect(delivered).toEqual([]);
			await port.sources.allow(GROUP);
			await route.handle(
				webhookRequest(body(messageEvent({ id: "r2", text: "routed" }))),
			);
			await until(() => delivered.length > 0);
			expect(delivered.map((m) => [m.channel, m.text, m.authorId])).toEqual([
				[GROUP, "routed", "Uuser0001"],
			]);
			await service("line-inbox").stop?.();
		});
	});

	describe("the sender icon route", () => {
		const png = new Uint8Array([
			0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4,
		]);

		test("serves the fixed bytes with a long cache header to GET and HEAD, and nothing else", async () => {
			const { contribution } = await boot({
				senderIconRoute: { path: "/line/staff-icon.png", png },
				listener: "edge",
			});
			const icon = contribution.http?.find(
				(r) => r.name === "line-sender-icon",
			);
			if (!icon) throw new Error("no icon route");
			expect(icon).toMatchObject({
				listener: "edge",
				path: { exact: "/line/staff-icon.png" },
				methods: ["GET", "HEAD"],
			});
			const got = await icon.handle(
				new Request("https://hook.example.test/line/staff-icon.png"),
			);
			expect(got.status).toBe(200);
			expect(got.headers.get("content-type")).toBe("image/png");
			expect(got.headers.get("cache-control")).toBe(
				"public, max-age=31536000, immutable",
			);
			expect(got.headers.get("content-length")).toBe(String(png.length));
			expect(new Uint8Array(await got.arrayBuffer())).toEqual(png);
			const head = await icon.handle(
				new Request("https://hook.example.test/line/staff-icon.png", {
					method: "HEAD",
				}),
			);
			expect(head.status).toBe(200);
			expect(head.headers.get("content-length")).toBe(String(png.length));
			expect((await head.arrayBuffer()).byteLength).toBe(0);
			// The webhook is still there beside it.
			expect(contribution.http?.map((r) => r.name).sort()).toEqual([
				"line-sender-icon",
				"line-webhook",
			]);
		});

		test("serves a copy: changing the bytes after the plugin was made changes nothing", async () => {
			const mine = new Uint8Array(png);
			const { contribution } = await boot({
				senderIconRoute: { path: "/line/staff-icon.png", png: mine },
			});
			mine[8] = 99;
			const icon = contribution.http?.find(
				(r) => r.name === "line-sender-icon",
			);
			const got = await icon?.handle(
				new Request("https://hook.example.test/line/staff-icon.png"),
			);
			expect(
				new Uint8Array((await got?.arrayBuffer()) ?? new ArrayBuffer(0))[8],
			).toBe(1);
		});
	});

	describe("sending and receiving, no secret in the logs", () => {
		test("the message text, the sender and the retry key stay out of the logs of a whole send, including a refusal", async () => {
			realClock = true;
			const { fake, service, route, port } = await boot(FAST);
			await route.handle(webhookRequest(body(messageEvent({ id: "l0" }))));
			await port.sources.allow(GROUP);
			port.subscribe(async () => undefined);
			await service("line-outbox").start?.();
			fake.pushScript.push({
				status: 400,
				body: { message: "PRIVATE-WORDS echoed", details: [] },
			});
			await port.outbox.enqueue(
				GROUP,
				[{ type: "text", text: "PRIVATE-WORDS" }],
				{
					sender: { name: "Hidden Name" },
				},
			);
			await until(
				async () =>
					(await sql`SELECT 1 FROM line_outbox WHERE status = 'dead'`).length >
					0,
			);
			await service("line-outbox").stop?.();
			const [row] = await sql`SELECT retry_key FROM line_outbox`;
			const everything = JSON.stringify(logs.lines) + JSON.stringify(port);
			for (const secret of [
				"PRIVATE-WORDS",
				"Hidden Name",
				row.retry_key,
				SECRET,
				...fake.issued,
			])
				expect(everything).not.toContain(secret);
			expect(
				logs.lines.some(
					(l) => l.fields.status === "dead" && l.fields.code === "http_400",
				),
			).toBe(true);
		});
	});

	/** One person in one allowed group, writing through the signed webhook and reading what the bot pushed. */
	const lineSubject = async () => {
		await truncateAll(sql);
		realClock = true;
		const { fake, contribution, service, route, port } = await boot({
			...FAST,
			route: true,
		});
		const surface = contribution.surfaces?.[0];
		if (!surface) throw new Error("no surface");
		let counter = 0;
		const detach = port.subscribe(async () => undefined);
		return {
			surface,
			channel: GROUP as `${string}:${string}`,
			join: async () => {
				await route.handle(webhookRequest(body(messageEvent({ id: "c0" }))));
				await port.sources.allow(GROUP);
				await service("line-inbox").start?.();
				await service("line-outbox").start?.();
			},
			write: async (text: string) => {
				await route.handle(
					webhookRequest(body(messageEvent({ id: `c${++counter}`, text }))),
				);
			},
			observations: () =>
				fake.pushes.map((push) => ({
					kind: "reply" as const,
					text: push.messages.map((m) => String(m.text)).join("\n"),
					files: [],
				})),
			close: async () => {
				detach();
				await service("line-inbox").stop?.();
				await service("line-outbox").stop?.();
			},
		};
	};
	describeSurfaceContract("the LINE surface", lineSubject);

	test("a reply is cut into text objects LINE takes, empty chunks are skipped, and another surface's channel is refused", async () => {
		const { contribution, route, port } = await boot();
		const surface = contribution.surfaces?.[0] as ChatSurface;
		await route.handle(webhookRequest(body(messageEvent({ id: "q0" }))));
		await port.sources.allow(GROUP);
		await surface.sendReply(GROUP as `${string}:${string}`, {
			chunks: ["a".repeat(5001), "  ", "short", "😀".repeat(2500) + "x"],
		});
		const [push] = await sql`SELECT messages FROM line_outbox`;
		const texts = (push.messages as { text: string }[]).map(
			(m) => m.text.length,
		);
		expect(texts).toEqual([5000, 1, 5, 5000, 1]);
		await expect(
			surface.sendReply("discord:123", { chunks: ["x"] }),
		).rejects.toThrow("not a LINE chat");
		await expect(
			surface.sendReply("line:nope", { chunks: ["x"] }),
		).rejects.toThrow("not a LINE chat");
		await expect(
			surface.sendReply("line:group:Cunknown", { chunks: ["x"] }),
		).rejects.toMatchObject({ code: "source_not_allowed" });
	});
});
