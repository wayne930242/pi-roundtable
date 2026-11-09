import { describe, expect, test } from "bun:test";
import type { ChatSurface, Contribution, InboundMessage } from "pi-roundtable";
import { describeDb } from "pi-roundtable/testing";
import { digestOf } from "./join.ts";
import type { LineEvent } from "./messages.ts";
import {
	BOT,
	body,
	GROUP,
	messageEvent,
	SECRET,
	webhookRequest,
} from "./testing/line-fake.ts";
import {
	advance,
	boot,
	ctl,
	FAST,
	logs,
	sql,
	until,
	usePluginHarness,
} from "./testing/plugin-fixture.ts";

describeDb("the line plugin: delivery", () => {
	usePluginHarness();

	test("a push queued through the service goes out under its sender and key, and the subscriber hears how it ended", async () => {
		// The clock is frozen, so what the gathering window collects is the test's to say, not the
		// machine's: both objects are queued at one instant, inside the window, however slow the
		// machine is, and the push is ready only when the test lets the window end.
		const { fake, service, route, port } = await boot(FAST);
		try {
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
			advance(FAST.outbox.coalesceMs);
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
					attempts: 1,
				},
			]);
			// A sender LINE would refuse never reaches the queue.
			await expect(
				port.outbox.enqueue(GROUP, [{ type: "text", text: "x" }], {
					sender: { name: "LINE desk" },
				}),
			).rejects.toMatchObject({ code: "bad_sender" });
			expect(fake.pushes).toHaveLength(1);
		} finally {
			// Whether it passed or not: a worker left running goes on claiming rows of the tests after it.
			await service("line-inbox").stop?.();
			await service("line-outbox").stop?.();
		}
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
			ctl.realClock = true;
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
			ctl.realClock = true;
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
			ctl.realClock = true;
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
			ctl.realClock = true;
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
			ctl.realClock = true;
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
			ctl.realClock = true;
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
});
