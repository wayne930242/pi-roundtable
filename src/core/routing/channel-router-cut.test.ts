import { expect, test } from "bun:test";
import type { ChannelClaim, InboundMessage } from "../contract/channels.ts";
import type { ChatSurface } from "../contract/surface.ts";
import type { TurnResult } from "../domain/conversation.ts";
import { silentLogger } from "../kernel/log.ts";
import { PERSONAL_TARGET } from "../shared/personal-target.ts";
import { mapIdentity } from "../testing/map-identity.ts";
import { ChannelQueue } from "./channel-queue.ts";
import { ChannelRouter } from "./channel-router.ts";
import { settleTurn } from "./settle-turn.ts";
import { systemTurn } from "./system-turns.ts";

const IDENTITY = mapIdentity({ owners: ["riley"] });

const message = (id: string): InboundMessage => ({
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
});

/**
 * A router whose claim runs each message's turn through `settleTurn` until `turn` resolves; a
 * message `reports` first asks for a background turn in another channel, which answers at once.
 */
function world() {
	const turn = Promise.withResolvers<TurnResult>();
	const left: string[] = [];
	let routing!: ChannelRouter;
	const claim: ChannelClaim = {
		name: "owner",
		priority: 0,
		owns: () => true,
		admit: (m) => ({
			kind: "turn",
			run: async () => {
				if (m.messageId === "reports")
					await routing.background(
						systemTurn({
							channel: "discord:2",
							target: PERSONAL_TARGET.name,
							author: { id: "host", name: "Host" },
							tier: "owner",
							turnId: "report",
							text: "report",
						}),
					);
				await settleTurn(() => turn.promise, "turn");
			},
			failure: "failed",
		}),
		background: async () => {
			await settleTurn(async () => ({ ok: true, text: "done" }), "report");
			return { status: "ran" };
		},
		startFresh: async () => "owner",
	};
	routing = new ChannelRouter({
		claims: [claim],
		targets: (name) =>
			name === PERSONAL_TARGET.name ? PERSONAL_TARGET : undefined,
		queue: new ChannelQueue(),
		logger: silentLogger(),
		contacts: IDENTITY,
		principals: IDENTITY,
		surfaces: {
			of: () =>
				({
					refuseStopping: async (m: InboundMessage) => {
						left.push(m.messageId);
						return true;
					},
				}) as ChatSurface,
			sendReply: async () => undefined,
		},
	});
	return { routing, turn, left };
}

const tally = () => ({ refused: 0, failed: 0, stopped: false });

test("a background turn a message's turn asks for does not answer that message", async () => {
	const { routing, turn, left } = world();
	void routing.handle(message("reports"));
	await Bun.sleep(5);
	routing.cutRunning();
	await routing.leaveCut(tally());
	expect(left).toEqual(["reports"]);
	turn.resolve({ ok: true, text: "late" });
});

test("only turns running when the drain limit passes are cut, each left once", async () => {
	const { routing, turn, left } = world();
	await routing.leaveCut(tally());
	void routing.handle(message("a"));
	await Bun.sleep(5);
	routing.cutRunning();
	routing.cutRunning();
	await routing.leaveCut(tally());
	await routing.leaveCut(tally());
	expect(left).toEqual(["a"]);
	turn.resolve({ ok: true, text: "late" });
});

test("a turn that failed or was stopped before the cut leaves its message; one that answered does not", async () => {
	for (const [result, expected] of [
		[{ ok: false, error: new Error("boom") }, ["a"]],
		[{ ok: false, error: new Error("stopped"), stopped: true }, ["a"]],
		[{ ok: true, text: "answer" }, []],
	] as const) {
		const { routing, turn, left } = world();
		const done = routing.handle(message("a"));
		await Bun.sleep(5);
		routing.cutRunning();
		turn.resolve(result as TurnResult);
		await done;
		const counted = tally();
		await routing.leaveCut(counted);
		expect(left).toEqual([...expected]);
		expect(counted.refused).toBe(expected.length);
	}
});
