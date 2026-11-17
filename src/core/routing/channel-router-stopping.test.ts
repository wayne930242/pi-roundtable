import { expect, test } from "bun:test";
import type { ChannelClaim, InboundMessage } from "../contract/channels.ts";
import type { ChatSurface } from "../contract/surface.ts";
import { silentLogger } from "../kernel/log.ts";
import { mapIdentity } from "../testing/map-identity.ts";
import { ChannelQueue } from "./channel-queue.ts";
import { ChannelRouter } from "./channel-router.ts";

const IDENTITY = mapIdentity({ owners: ["riley"] });

const message = (id: string, extra: Partial<InboundMessage> = {}) =>
	({
		channel: "discord:1",
		messageId: id,
		authorId: "riley",
		authorName: "Riley",
		authorIsBot: false,
		isDirect: true,
		mentionsBot: false,
		repliesToBot: false,
		text: id,
		attachments: [],
		...extra,
	}) satisfies InboundMessage;

/** A router over a closed queue, as the host shuts down, whose surface may take refused messages. */
function stopping(refuseStopping?: ChatSurface["refuseStopping"]) {
	const posted: string[] = [];
	const refused: string[] = [];
	const claim: ChannelClaim = {
		name: "owner",
		priority: 0,
		owns: () => true,
		admit: () => ({
			kind: "turn",
			run: async () => undefined,
			failure: "failed",
		}),
		startFresh: async () => "owner",
	};
	const queue = new ChannelQueue();
	queue.close();
	const surface = {
		...(refuseStopping
			? {
					refuseStopping: async (m: InboundMessage) => {
						refused.push(m.messageId);
						return refuseStopping(m);
					},
				}
			: {}),
	} as ChatSurface;
	const routing = new ChannelRouter({
		claims: [claim],
		targets: () => undefined,
		queue,
		logger: silentLogger(),
		contacts: IDENTITY,
		principals: IDENTITY,
		surfaces: {
			of: () => surface,
			sendReply: async (_channel, reply) => {
				posted.push(reply.chunks.join(""));
			},
		},
	});
	return { routing, posted, refused };
}

test("a message refused as the host stops goes to its surface first; one it takes gets no restart notice", async () => {
	const world = stopping(async () => true);
	await world.routing.handle(message("a"));
	await world.routing.handle(message("b"));
	expect(world.refused).toEqual(["a", "b"]);
	expect(world.posted).toEqual([]);
});

test("without the surface taking it, or when it fails, routing tells the channel once", async () => {
	const none = stopping();
	await none.routing.handle(message("a"));
	await none.routing.handle(message("b"));
	expect(none.posted).toHaveLength(1);
	const failing = stopping(async () => {
		throw new Error("down");
	});
	await failing.routing.handle(message("a"));
	expect(failing.posted).toHaveLength(1);
	const bot = stopping(async () => true);
	await bot.routing.handle(message("c", { authorIsBot: true }));
	expect(bot.refused).toEqual([]);
});

/** A router whose first message holds its channel, and whose surface takes every refused message. */
function waitingWorld(marked: boolean) {
	const ran: string[] = [];
	const running = Promise.withResolvers<void>();
	const claim: ChannelClaim = {
		name: "owner",
		priority: 0,
		owns: () => true,
		admit: (m) => ({
			kind: "turn",
			...(marked
				? {
						busy: {
							react: async () => undefined,
							unreact: async () => undefined,
						},
					}
				: {}),
			run: async () => {
				ran.push(m.messageId);
				if (m.messageId === "first") await running.promise;
			},
			failure: "failed",
		}),
		startFresh: async () => "owner",
	};
	const refused: string[] = [];
	const queue = new ChannelQueue();
	const routing = new ChannelRouter({
		claims: [claim],
		targets: () => undefined,
		queue,
		logger: silentLogger(),
		contacts: IDENTITY,
		principals: IDENTITY,
		surfaces: {
			of: () =>
				({
					refuseStopping: async (m: InboundMessage) => {
						refused.push(m.messageId);
						return true;
					},
				}) as ChatSurface,
			sendReply: async () => undefined,
		},
	});
	const first = routing.handle(message("first"));
	return { routing, queue, ran, refused, running, first };
}

for (const marked of [true, false])
	test(`a message still waiting behind a turn when the drain ends is refused at once, through its surface, and never runs (${marked ? "a claim that marks it" : "a claim without a waiting mark"})`, async () => {
		const { routing, queue, ran, refused, running, first } =
			waitingWorld(marked);
		await Bun.sleep(1);
		const waiting = routing.handle(message("waiting"));
		await Bun.sleep(1);
		// Only a marked message is listed for its author to cancel or edit.
		expect(routing.queued("discord:1").map((q) => q.messageId)).toEqual(
			marked ? ["waiting"] : [],
		);
		queue.close();
		queue.seal();
		const tally = { refused: 0, failed: 0, stopped: false };
		await routing.refuseWaiting(tally);
		expect(tally).toEqual({ refused: 1, failed: 0, stopped: false });
		expect(refused).toEqual(["waiting"]);
		expect(routing.queued("discord:1")).toEqual([]);
		running.resolve();
		await Promise.all([first, waiting]);
		await Bun.sleep(1);
		expect(ran).toEqual(["first"]);
		expect(refused).toEqual(["waiting"]);
	});

test("a message waiting unmarked behind a turn that ends after the drain began is refused once, by its own task", async () => {
	const { routing, queue, ran, refused, running, first } = waitingWorld(false);
	await Bun.sleep(1);
	const waiting = routing.handle(message("waiting"));
	await Bun.sleep(1);
	queue.close();
	queue.seal();
	running.resolve();
	await Promise.all([first, waiting]);
	const tally = { refused: 0, failed: 0, stopped: false };
	await routing.refuseWaiting(tally);
	expect(tally.refused).toBe(0);
	expect(ran).toEqual(["first"]);
	expect(refused).toEqual(["waiting"]);
});
