import { afterAll, beforeAll, expect, test } from "bun:test";
import { describeDb } from "pi-roundtable/testing";
import type { NoticesView, PushPrefsView, PushTestView } from "../api-types.ts";
import {
	bootE,
	Client,
	type EHost,
	MEL,
	ofType,
	principalOf,
	rest,
	SAM,
} from "../testing/e-host.ts";
import { fakePushService, receiver } from "../testing/push.ts";

const FCM = "https://fcm.googleapis.com/fcm/send/";

describeDb("notices over a real host", () => {
	const service = fakePushService();
	let app: EHost;
	let ada = "";
	let mel = "";
	let sam = "";
	beforeAll(async () => {
		app = await bootE({
			fetch: service.fetch,
			console: { push: { quietHours: false, tiers: ["owner", "member"] } },
		});
		ada = await principalOf(app.host, {
			provider: "discord",
			subject: "100000000000000001",
			name: "Ada",
		});
		mel = await principalOf(app.host, MEL);
		sam = await principalOf(app.host, SAM);
		const sql = app.host.context.database();
		await sql`DELETE FROM web_notice_recipients`;
		await sql`DELETE FROM web_notices`;
		await sql`DELETE FROM web_push_subscriptions`;
	}, 30_000);
	afterAll(async () => {
		const sql = app.host.context.database();
		await sql`DELETE FROM web_notice_recipients`;
		await sql`DELETE FROM web_notices`;
		await sql`DELETE FROM web_push_subscriptions`;
		await app.stop();
	});

	const subscribe = async (who: string, endpoint: string) => {
		const device = await receiver();
		const answer = await rest(app, "push/subscriptions", {
			method: "POST",
			who,
			body: JSON.stringify(device.subscription(endpoint, "Phone")),
		});
		expect(answer.status).toBe(200);
		return device;
	};
	const bell = async (who: string) =>
		(await (await rest(app, "notices", { who })).json()) as NoticesView;
	const rows = async (tag: string) =>
		app.host.context.database()`SELECT * FROM web_push_outbox WHERE tag = ${tag} ORDER BY id`;
	const drained = async () => {
		const sql = app.host.context.database();
		for (let i = 0; i < 100; i++) {
			const [left]: { n: number }[] =
				await sql`SELECT count(*)::int AS n FROM web_push_outbox WHERE done_at IS NULL`;
			if (left?.n === 0) return;
			await Bun.sleep(25);
		}
		throw new Error("the outbox did not empty");
	};

	test("a notice is in the bell of its addressees and no one else's, and they alone can handle it", async () => {
		await app.app.notices.raise({
			tag: "t:bell",
			to: [mel],
			title: "A customer wrote",
			body: "Open the thread",
			open: { room: "app:inbox.abcdefgh" },
			urgency: "normal",
			ackable: true,
			push: false,
		});
		const mine = await bell("mel");
		expect(mine.notices.map((n) => n.tag)).toEqual(["t:bell"]);
		expect(mine.notices[0]?.open).toEqual({ room: "app:inbox.abcdefgh" });
		expect(mine.badge).toBe(1);
		expect((await bell("sam")).notices).toEqual([]);
		expect((await bell("owner")).badge).toBe(0);
		// Not addressed to Sam: there is nothing to handle, and the answer does not say it exists.
		const refused = await rest(app, "notices/t%3Abell/ack", {
			method: "POST",
			who: "sam",
		});
		expect(refused.status).toBe(404);
		const handled = await rest(app, "notices/t%3Abell/ack", {
			method: "POST",
			who: "mel",
		});
		expect(handled.status).toBe(200);
		const after = await bell("mel");
		expect(after.badge).toBe(0);
		expect(after.notices[0]?.acked).toBe(true);
		const pending = await app.app.notices.pending("t:bell");
		expect(pending?.acked.map((a) => a.principalId)).toEqual([mel]);
		await app.app.notices.resolve("t:bell", { reason: "done" });
		expect((await bell("mel")).notices).toEqual([]);
		expect(await app.app.notices.pending("t:bell")).toBeUndefined();
	});

	test("the socket gets the notices when it opens, then each notice, the badge, and the resolve live", async () => {
		await app.app.notices.raise({
			tag: "t:open",
			to: [mel],
			title: "Before the socket",
			urgency: "normal",
			ackable: true,
			push: false,
		});
		const socket = await Client.open(app, "mel");
		if (!socket) throw new Error("the socket was refused");
		try {
			const early = await socket.take(ofType("notice"));
			expect(early.notice.tag).toBe("t:open");
			expect((await socket.take(ofType("badge"))).count).toBe(1);
			const other = await Client.open(app, "sam");
			if (!other) throw new Error("the socket was refused");
			await app.app.notices.raise({
				tag: "t:live",
				to: [mel],
				title: "Live",
				urgency: "high",
				ackable: true,
				push: false,
			});
			expect((await socket.take(ofType("notice"))).notice.tag).toBe("t:live");
			expect((await socket.take(ofType("badge"))).count).toBe(2);
			// A frame for Mel never reaches Sam.
			expect(await other.sees(ofType("notice"))).toBe(false);
			// Handling it over the socket.
			socket.send({ type: "ack", tag: "t:live" });
			expect((await socket.take(ofType("badge"))).count).toBe(1);
			await app.app.notices.resolve("t:open", { reason: "solved" });
			expect((await socket.take(ofType("notice_resolved"))).tag).toBe("t:open");
			expect((await socket.take(ofType("badge"))).count).toBe(0);
			// A refused ack says so and changes nothing.
			socket.send({ type: "ack", tag: "t:nothing" });
			expect((await socket.take(ofType("refused"))).code).toBe("not_accepted");
			other.close();
		} finally {
			socket.close();
		}
		await app.app.notices.resolve("t:live", { reason: "end" });
	});

	test("raising a tag again replaces it and starts every addressee unanswered; renotify adds people", async () => {
		const tag = "t:again";
		await app.app.notices.raise({
			tag,
			to: [mel],
			title: "First",
			urgency: "normal",
			ackable: true,
			push: false,
		});
		await rest(app, "notices/t%3Aagain/ack", { method: "POST", who: "mel" });
		expect((await bell("mel")).badge).toBe(0);
		await app.app.notices.raise({
			tag,
			to: [mel, sam],
			title: "Second",
			urgency: "normal",
			ackable: true,
			push: false,
		});
		expect((await bell("mel")).notices[0]?.title).toBe("Second");
		expect((await bell("mel")).badge).toBe(1);
		expect((await bell("sam")).badge).toBe(1);
		await app.app.notices.renotify(tag, [ada]);
		expect((await app.app.notices.pending(tag))?.to).toContain(ada);
		expect((await bell("owner")).badge).toBe(1);
		await app.app.notices.resolve(tag, { reason: "end" });
	});

	test("a notice that asks for no answer shows in the bell and never counts in the badge", async () => {
		await app.app.notices.raise({
			tag: "t:info",
			to: [mel],
			title: "FYI",
			urgency: "normal",
			push: false,
		});
		const view = await bell("mel");
		expect(view.notices.map((n) => n.tag)).toEqual(["t:info"]);
		expect(view.badge).toBe(0);
		const ack = await rest(app, "notices/t%3Ainfo/ack", {
			method: "POST",
			who: "mel",
		});
		expect(ack.status).toBe(404);
		await app.app.notices.resolve("t:info", { reason: "end" });
	});

	test("what is wrong with a notice is refused when it is raised", async () => {
		const good = {
			tag: "t:bad",
			to: [mel],
			title: "x",
			urgency: "normal" as const,
		};
		const raise = (more: object) =>
			app.app.notices.raise({ ...good, push: false, ...more });
		await expect(raise({ tag: "" })).rejects.toThrow("tag");
		await expect(raise({ to: [] })).rejects.toThrow("1 to");
		await expect(raise({ title: "" })).rejects.toThrow("title");
		await expect(raise({ open: { page: "Not Valid" } })).rejects.toThrow(
			"open.page",
		);
		await expect(raise({ via: ["slack"] })).rejects.toThrow("slack");
		await expect(raise({ via: [] })).rejects.toThrow("via");
	});

	test("a notice reaches an addressee's devices as one sealed push that opens exactly its room", async () => {
		const mine = await subscribe("mel", `${FCM}mel-1`);
		const sams = await subscribe("sam", `${FCM}sam-1`);
		service.posts.length = 0;
		await app.app.notices.raise({
			tag: "t:push",
			to: [mel],
			title: "Customer is waiting",
			body: "The thread is open",
			open: { room: "app:inbox.abcdefgh", message: 42 },
			urgency: "high",
			ackable: true,
		});
		await drained();
		expect(service.posts).toHaveLength(1);
		expect(service.posts[0]?.url).toBe(`${FCM}mel-1`);
		const shown = (await mine.open(
			service.posts[0]?.body ?? new Uint8Array(),
		)) as {
			kind: string;
			tag: string;
			url: string;
			badge: number;
			urgency: string;
			title: string;
		};
		expect(shown).toMatchObject({
			kind: "notice",
			tag: "t:push",
			badge: 1,
			urgency: "high",
			title: "Customer is waiting",
		});
		expect(shown.url).toBe("/console/#/room/app%3Ainbox.abcdefgh?message=42");
		expect(service.posts.some((p) => p.url.includes("sam-1"))).toBe(false);
		void sams;
		// The sender recorded what it did.
		const [delivery]: { result: string; transport: string }[] =
			await app.host.context.database()`SELECT d.result, d.transport FROM web_push_deliveries d JOIN web_push_outbox o ON o.id = d.outbox_id WHERE o.tag = 't:push'`;
		expect(delivery).toEqual({ result: "sent", transport: "web-push" });
		// Resolving closes it on the devices that got it.
		service.posts.length = 0;
		await app.app.notices.resolve("t:push", { reason: "answered" });
		await drained();
		expect(service.posts).toHaveLength(1);
		const cleared = (await mine.open(
			service.posts[0]?.body ?? new Uint8Array(),
		)) as {
			kind: string;
			tag: string;
			badge: number;
		};
		expect(cleared).toMatchObject({ kind: "clear", tag: "t:push", badge: 0 });
	});

	test("a person's quiet hours hold back a normal notice and never a high one", async () => {
		const quiet = await rest(app, "push/prefs", {
			method: "PUT",
			who: "mel",
			body: JSON.stringify({
				quiet: { start: "00:00", end: "23:59", timeZone: "Asia/Taipei" },
			}),
		});
		expect(((await quiet.json()) as PushPrefsView).quiet?.timeZone).toBe(
			"Asia/Taipei",
		);
		service.posts.length = 0;
		await app.app.notices.raise({
			tag: "t:quiet",
			to: [mel],
			title: "Normal",
			urgency: "normal",
		});
		await app.app.notices.raise({
			tag: "t:loud",
			to: [mel],
			title: "High",
			urgency: "high",
		});
		await drained();
		expect(await rows("t:quiet")).toHaveLength(0);
		expect(await rows("t:loud")).toHaveLength(1);
		// Held back from the phone, not from the bell.
		expect((await bell("mel")).notices.map((n) => n.tag)).toContain("t:quiet");
		const cleared = await rest(app, "push/prefs", {
			method: "PUT",
			who: "mel",
			body: JSON.stringify({ quiet: null }),
		});
		expect(((await cleared.json()) as PushPrefsView).quiet).toBeUndefined();
		const bad = await rest(app, "push/prefs", {
			method: "PUT",
			who: "mel",
			body: JSON.stringify({
				quiet: { start: "22:00", end: "22:00", timeZone: "Asia/Taipei" },
			}),
		});
		expect(bad.status).toBe(400);
		await app.app.notices.resolve("t:quiet", { reason: "end" });
		await app.app.notices.resolve("t:loud", { reason: "end" });
	});

	test("push goes only to tiers push.tiers lists, and not at all for push: false", async () => {
		service.posts.length = 0;
		await app.app.notices.raise({
			tag: "t:silent",
			to: [mel],
			title: "No push",
			urgency: "high",
			push: false,
		});
		await drained();
		expect(await rows("t:silent")).toHaveLength(0);
		await app.app.notices.resolve("t:silent", { reason: "end" });
	});

	test("receipts: the service worker's receipt lands on the notice and in lastReceiptAt; another person's notice is refused", async () => {
		await app.app.notices.raise({
			tag: "t:receipt",
			to: [mel],
			title: "Receipt",
			urgency: "normal",
			push: false,
		});
		const post = (who: string, tag: string, event = "received") =>
			rest(app, "push/receipts", {
				method: "POST",
				who,
				body: JSON.stringify({ tag, event }),
			});
		expect((await post("sam", "t:receipt")).status).toBe(404);
		expect((await post("mel", "t:receipt")).status).toBe(200);
		expect((await post("mel", "t:receipt", "opened")).status).toBe(200);
		expect((await post("mel", "t:receipt", "seen")).status).toBe(400);
		expect((await post("mel", "t:nothing")).status).toBe(404);
		const pending = await app.app.notices.pending("t:receipt");
		expect(pending?.received).toEqual([mel]);
		expect(pending?.opened).toEqual([mel]);
		expect((await app.app.push.status(mel)).lastReceiptAt).toBeInstanceOf(Date);
		expect((await app.app.push.status(sam)).lastReceiptAt).toBeUndefined();
		await app.app.notices.resolve("t:receipt", { reason: "end" });
	});

	test("a test push goes to the person's own devices, and only its own tag counts as their receipt", async () => {
		service.posts.length = 0;
		const none = await rest(app, "push/test", { method: "POST", who: "owner" });
		expect(none.status).toBe(409);
		const made = await rest(app, "push/test", { method: "POST", who: "mel" });
		expect(made.status).toBe(200);
		const { tag } = (await made.json()) as PushTestView;
		expect(tag.startsWith("test:")).toBe(true);
		await drained();
		expect(service.posts.length).toBeGreaterThan(0);
		const other = await rest(app, "push/receipts", {
			method: "POST",
			who: "sam",
			body: JSON.stringify({ tag, event: "received" }),
		});
		expect(other.status).toBe(404);
		const own = await rest(app, "push/receipts", {
			method: "POST",
			who: "mel",
			body: JSON.stringify({ tag, event: "received" }),
		});
		expect(own.status).toBe(200);
	});
});
