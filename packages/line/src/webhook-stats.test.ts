import { expect, test } from "bun:test";
import type { SQL } from "bun";
import { recordingLogger } from "pi-roundtable/testing";
import {
	BOT,
	body,
	CHANNEL_ID,
	fakeLine,
	messageEvent,
	SECRET,
	sign,
	webhookRequest,
} from "./testing/line-fake.ts";
import { TokenSource } from "./token.ts";
import { WebhookStats, webhookHandler } from "./webhook.ts";

// Every answer counted here is given before the handler reaches the database, so none is needed.
const database = undefined as unknown as SQL;
const tokens = new TokenSource({
	credentials: { channelId: CHANNEL_ID, channelSecret: SECRET },
	fetch: fakeLine().fetch,
});

function setup(bot: string | null = BOT) {
	const stats = new WebhookStats();
	let clock = new Date("2026-10-13T00:00:00Z");
	const handler = webhookHandler({
		sql: database,
		tokens,
		logger: recordingLogger().logger,
		now: () => clock,
		botUserId: () => bot ?? undefined,
		stored: () => undefined,
		stats,
		maxBytes: 4096,
	});
	return {
		stats,
		handler,
		at: (iso: string) => {
			clock = new Date(iso);
		},
	};
}

test("a new counter holds zeros and no times", () => {
	expect(new WebhookStats().health()).toEqual({
		accepted: 0,
		rejected: { signature: 0, destination: 0, malformed: 0 },
	});
});

test("each refusal adds to its own count and stamps lastRejectedAt", async () => {
	const { stats, handler, at } = setup();
	const events = body(messageEvent({ text: "words that must not be counted" }));

	at("2026-10-13T01:00:00Z");
	expect(
		(await handler(webhookRequest(events, { signature: null }))).status,
	).toBe(401);
	expect(
		(
			await handler(
				webhookRequest(events, { signature: sign(events, "other") }),
			)
		).status,
	).toBe(401);

	at("2026-10-13T02:00:00Z");
	const notJson = "not json";
	expect((await handler(webhookRequest(notJson))).status).toBe(400);
	const big = "x".repeat(5000);
	expect((await handler(webhookRequest(big))).status).toBe(413);

	at("2026-10-13T03:00:00Z");
	const elsewhere = JSON.stringify({ destination: "Uother", events: [{}] });
	expect((await handler(webhookRequest(elsewhere))).status).toBe(403);

	expect(stats.health()).toEqual({
		accepted: 0,
		rejected: { signature: 2, destination: 1, malformed: 2 },
		lastRejectedAt: "2026-10-13T03:00:00.000Z",
	});
});

test("a signed empty events object (LINE's Verify) is accepted and stamps lastAcceptedAt", async () => {
	const { stats, handler, at } = setup();
	at("2026-10-13T04:00:00Z");
	expect((await handler(webhookRequest(body()))).status).toBe(200);
	expect(stats.health()).toEqual({
		accepted: 1,
		rejected: { signature: 0, destination: 0, malformed: 0 },
		lastAcceptedAt: "2026-10-13T04:00:00.000Z",
	});
});

test("the snapshot is a copy, and carries counts and times only", async () => {
	const { stats, handler } = setup();
	await handler(webhookRequest(body(), { signature: "forged" }));
	const first = stats.health();
	first.rejected.signature = 99;
	const second = stats.health();
	expect(second.rejected.signature).toBe(1);
	expect(Object.keys(second).sort()).toEqual([
		"accepted",
		"lastRejectedAt",
		"rejected",
	]);
});

test("before the bot is known a signed webhook for any destination is accepted", async () => {
	const { stats, handler } = setup(null);
	const elsewhere = JSON.stringify({ destination: "Uother", events: [] });
	expect((await handler(webhookRequest(elsewhere))).status).toBe(200);
	expect(stats.health().accepted).toBe(1);
});
