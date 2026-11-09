import { afterAll, beforeAll, expect, test } from "bun:test";
import { promptScope } from "pi-roundtable";
import { describeDb } from "pi-roundtable/testing";
import { fakePushService, receiver } from "../testing/push.ts";
import {
	type Booted,
	boot,
	Client,
	FCM,
	ofType,
	rest,
	SCOUT,
	utcClock,
	waitFor,
} from "../testing/push-host.ts";

describeDb("push in the quiet hours over a real host", () => {
	const service = fakePushService(() => 201);
	let app: Booted;
	beforeAll(async () => {
		const now = Date.now();
		// A window of four hours around now, so the suite does not depend on the hour it runs at.
		app = await boot({
			fetch: service.fetch,
			graceSeconds: 5,
			quietHours: {
				start: utcClock(now - 2 * 3_600_000),
				end: utcClock(now + 2 * 3_600_000),
			},
		});
		await app.host.context.database()`DELETE FROM web_push_subscriptions`;
	}, 30_000);
	afterAll(async () => {
		await app.host.context.database()`DELETE FROM web_push_subscriptions`;
		await app.stop();
	});

	test("an agent's post is not pushed, a waiting card is, and the page is told the window", async () => {
		const device = await receiver();
		const added = await rest(app, "push/subscriptions", {
			method: "POST",
			body: JSON.stringify(device.subscription(`${FCM}quiet`, "Quiet phone")),
		});
		expect(added.status).toBe(200);
		const session = (await (await rest(app, "session")).json()) as {
			quietHours?: { start: string; end: string; timeZone: string };
		};
		expect(session.quietHours).toMatchObject({ timeZone: "UTC" });
		await app.host.context.surfaces.sendReply(SCOUT, {
			chunks: ["the nightly report is ready"],
			author: { name: "Scout", agent: "scout" },
		});
		await Bun.sleep(300);
		expect(service.posts).toHaveLength(0);
		app.scripts.set("hold-quiet", async (request) => {
			const prompts = app.host.context.surfaces.prompts(
				request.channel,
				promptScope(request.speaker),
			);
			await prompts?.confirm("Send it?", "details", undefined, "owner");
			return { ok: true, text: "done" };
		});
		const tab = await Client.open(app, { "x-actor": "owner" });
		if (!tab) throw new Error("the owner was refused");
		await tab.take(ofType("ready"));
		tab.send({ type: "hello", visible: false });
		tab.send({ type: "send", id: "q1", room: SCOUT, text: "hold-quiet" });
		const card = await tab.take(ofType("prompt"));
		await waitFor(() => service.posts.length === 1);
		const post = service.posts[0];
		if (!post) throw new Error("no push");
		expect(await device.open(post.body)).toMatchObject({
			kind: "card",
			title: "Card waiting",
			room: SCOUT,
		});
		tab.send({ type: "approval", prompt: card.prompt.id, approved: false });
		tab.close();
	});
});
