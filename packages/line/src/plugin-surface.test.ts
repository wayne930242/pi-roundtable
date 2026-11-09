import { expect, test } from "bun:test";
import type { ChatSurface } from "pi-roundtable";
import { describeDb, describeSurfaceContract } from "pi-roundtable/testing";
import {
	body,
	GROUP,
	messageEvent,
	webhookRequest,
} from "./testing/line-fake.ts";
import {
	boot,
	ctl,
	FAST,
	sql,
	usePluginHarness,
} from "./testing/plugin-fixture.ts";
import { truncateAll } from "./testing/pool.ts";

describeDb("the line plugin: surface", () => {
	usePluginHarness();

	/** One person in one allowed group, writing through the signed webhook and reading what the bot pushed. */
	const lineSubject = async () => {
		await truncateAll(sql);
		ctl.realClock = true;
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

	test("the surface tells the model LINE shows plain text, unless the host says otherwise", async () => {
		const told = (await boot()).contribution.surfaces?.[0]?.formatting;
		expect(told).toContain("plain text only");
		expect(told).toContain("LINE");
		expect(told?.length).toBeLessThan(400);
		expect(
			(await boot({ formatting: "Short and bare." })).contribution.surfaces?.[0]
				?.formatting,
		).toBe("Short and bare.");
		expect(
			(await boot({ formatting: false })).contribution.surfaces?.[0]
				?.formatting,
		).toBeUndefined();
	});

	test("a reply is cut into text objects LINE takes, empty chunks are skipped, and another surface's channel is refused", async () => {
		const { contribution, route, port } = await boot();
		const surface = contribution.surfaces?.[0] as ChatSurface;
		await route.handle(webhookRequest(body(messageEvent({ id: "q0" }))));
		await port.sources.allow(GROUP);
		await surface.sendReply(GROUP as `${string}:${string}`, {
			chunks: ["a".repeat(5001), "  ", "short", `${"😀".repeat(2500)}x`],
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
