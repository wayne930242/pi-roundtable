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
