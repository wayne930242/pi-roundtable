import { expect, test } from "bun:test";
import { describeDb } from "pi-roundtable/testing";
import { digestOf } from "./join.ts";
import type { LineEvent } from "./messages.ts";
import { line } from "./plugin.ts";
import { LINE } from "./port.ts";
import {
	BOT,
	body,
	GROUP,
	messageEvent,
	SECRET,
	sign,
	webhookRequest,
} from "./testing/line-fake.ts";
import { claimParker } from "./testing/park-claim.ts";
import {
	advance,
	boot,
	credentials,
	logs,
	POLL_MS,
	sql,
	time,
	until,
	usePluginHarness,
} from "./testing/plugin-fixture.ts";

test("formatting guidance with nothing in it throws when the plugin is made", () => {
	expect(() => line({ credentials, formatting: " " })).toThrow(
		"line: formatting is empty",
	);
	expect(() => line({ credentials, formatting: false })).not.toThrow();
});

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

describeDb("the line plugin: wiring", () => {
	usePluginHarness();

	test("it contributes the webhook route, the surface, four services and the LINE service, and declares its migration", async () => {
		const { plugin, contribution, route, port } = await boot();
		expect(plugin.name).toBe("line");
		expect(plugin.provides).toEqual([LINE]);
		expect(plugin.migrations?.map((m) => m.name)).toEqual([
			"inbox",
			"messages",
			"outbox",
			"outbox-requested",
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
			"api",
			"botUserId",
			"content",
			"health",
			"outbox",
			"screen",
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
		expect(port.health()).toMatchObject({
			tokensIssued: 1,
			tokenFailure: undefined,
			webhooks: { accepted: 2, rejected: { signature: 1 } },
		});
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
		// The worker may have claimed s2 as the first subscriber went and put it back for a moment
		// (the next test makes it so); the clock stands still, so let that moment pass. The put-back
		// reads the clock when it is written, which may be after any one step of it, so the clock
		// goes on stepping while the test waits.
		const second: LineEvent[] = [];
		port.subscribe(async (event) => {
			second.push(event);
		});
		await until(() => {
			advance(POLL_MS);
			return second.length >= 1;
		});
		expect(second.map((e) => (e as { eventId: string }).eventId)).toEqual([
			"s2",
		]);
		await service("line-inbox").stop?.();
	});

	test("an event the worker claims as the subscriber goes is put back uncounted and goes to the next subscriber once its moment has passed", async () => {
		const parker = claimParker(sql);
		const { service, route, port } = await boot({}, parker.sql);
		try {
			await service("line-inbox").start?.();
			await route.handle(webhookRequest(body(messageEvent({ id: "c0" }))));
			await port.sources.allow(GROUP);
			await route.handle(webhookRequest(body(messageEvent({ id: "c1" }))));
			const status = async (id: string) =>
				(
					await sql`SELECT status, attempts, requeues, last_error_code FROM line_inbox WHERE webhook_event_id = ${id}`
				)[0];
			const first: LineEvent[] = [];
			const detach = port.subscribe(async (event) => {
				first.push(event);
			});
			await until(async () => (await status("c1"))?.status === "done");
			// The worker's next look at the inbox begins with the subscriber still attached ...
			const letGo = await parker.park();
			// ... and goes on only after the subscriber has gone and c2 has come in.
			detach();
			await route.handle(webhookRequest(body(messageEvent({ id: "c2" }))));
			letGo();
			await until(async () => (await status("c2"))?.last_error_code != null);
			expect(await status("c2")).toMatchObject({
				status: "pending",
				attempts: 0,
				requeues: 0,
				last_error_code: "no_processor",
			});
			expect(first.map((e) => (e as { eventId: string }).eventId)).toEqual([
				"c1",
			]);
			// It comes due once the moment has passed; the next subscriber is handed it, as attempt one.
			advance(POLL_MS);
			const second: LineEvent[] = [];
			port.subscribe(async (event) => {
				second.push(event);
			});
			await until(() => second.length >= 1);
			expect(second.map((e) => (e as { eventId: string }).eventId)).toEqual([
				"c2",
			]);
			await until(async () => (await status("c2"))?.status === "done");
			expect(await status("c2")).toMatchObject({ status: "done", attempts: 1 });
		} finally {
			// Whether it passed or not: a worker left running goes on claiming rows of the tests after it.
			await service("line-inbox").stop?.();
		}
	});

	test("one screen at a time: a second is refused, detaching frees the place, and it leaves the subscriber alone", async () => {
		const { service, route, port } = await boot();
		await service("line-inbox").start?.();
		await route.handle(webhookRequest(body(messageEvent({ id: "p0" }))));
		await port.sources.allow(GROUP);
		const got: string[] = [];
		const detachSubscriber = port.subscribe(async (event) => {
			if (event.type === "message") got.push(event.eventId);
			return undefined;
		});
		const detach = port.screen(async (event) =>
			event.id === "taken" ? "consume" : "keep",
		);
		expect(() => port.screen(async () => "keep")).toThrow("already attached");
		expect(() => port.screen("x" as never)).toThrow("function");
		await route.handle(
			webhookRequest(
				body(
					messageEvent({ id: "taken", text: "to the screen only" }),
					messageEvent({ id: "kept" }),
				),
			),
		);
		for (let i = 0; i < 400 && got.length < 1; i++) await Bun.sleep(10);
		await Bun.sleep(50);
		expect(got).toEqual(["kept"]);
		const dump = JSON.stringify(await sql`SELECT * FROM line_inbox`);
		expect(dump).not.toContain("to the screen only");
		expect(dump).not.toContain("reply-taken");

		// Once detached every event is kept again, as before a screen was attached.
		detach();
		detach();
		await route.handle(
			webhookRequest(body(messageEvent({ id: "taken", text: "now kept" }))),
		);
		for (let i = 0; i < 400 && got.length < 2; i++) await Bun.sleep(10);
		expect(got).toEqual(["kept", "taken"]);

		// A stale detach does not remove a screen attached after it.
		const second = port.screen(async () => "consume");
		detach();
		const response = await route.handle(
			webhookRequest(body(messageEvent({ id: "later" }))),
		);
		expect(response.status).toBe(200);
		await Bun.sleep(50);
		expect(got).toEqual(["kept", "taken"]);
		second();
		detachSubscriber();
		await service("line-inbox").stop?.();
	});

	test("the API port goes through the plugin's token: a failure is told to its listener and shows in health", async () => {
		const { fake, port } = await boot();
		fake.profiles["Cgroup0001/Uone"] = { displayName: "Ada" };
		const told: string[] = [];
		port.api.onTokenFailure((code) => told.push(code));
		expect(await port.api.profile(GROUP, "Uone")).toEqual({
			displayName: "Ada",
		});
		expect(port.health().tokensIssued).toBe(1);
		fake.revoke("access-token-1");
		fake.failTokens(500);
		await expect(port.api.profile(GROUP, "Uone")).rejects.toMatchObject({
			code: "token_refused",
		});
		expect(told).toEqual(["token_refused"]);
		expect(port.health().tokenFailure).toBe("token_refused");
		expect(await port.api.probeToken()).toBe("token_refused");
		expect(told).toEqual(["token_refused"]);
		fake.failTokens(undefined);
		expect(await port.api.probeToken()).toBeUndefined();
		expect((await port.api.botInfo()).basicId).toBe("@bot-for-tests");
		expect(await port.api.quota()).toEqual({
			limit: 1000,
			used: 0,
			cap: undefined,
		});
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
