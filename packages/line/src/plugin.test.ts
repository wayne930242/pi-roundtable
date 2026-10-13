import { afterAll, beforeEach, expect, test } from "bun:test";
import type { SQL } from "bun";
import type {
	Contribution,
	PluginContext,
	Service,
	ServiceKey,
} from "pi-roundtable";
import { describeDb, partial, recordingLogger } from "pi-roundtable/testing";
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

describeDb("the line plugin", () => {
	let sql: SQL;
	const time = new Date("2026-10-13T00:00:00Z");
	const logs = recordingLogger();
	let provided: unknown;

	const context = (): PluginContext =>
		partial<PluginContext>({
			logger: logs.logger,
			env: partial<PluginContext["env"]>({ now: () => time }),
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
		const route = contribution.http?.[0];
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
	});
	afterAll(async () => {
		await sql?.close();
	});

	test("it contributes the webhook route, three services and the LINE service, and declares its migration", async () => {
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
			"line-retention",
		]);
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
});
