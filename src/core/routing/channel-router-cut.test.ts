import { expect, test } from "bun:test";
import type { ChannelClaim, InboundMessage } from "../contract/channels.ts";
import type { ChatSurface } from "../contract/surface.ts";
import type { TurnResult } from "../domain/conversation.ts";
import type { ChannelKey } from "../domain/sessions.ts";
import { silentLogger } from "../kernel/log.ts";
import { PERSONAL_TARGET } from "../shared/personal-target.ts";
import { mapIdentity } from "../testing/map-identity.ts";
import { ChannelQueue } from "./channel-queue.ts";
import { ChannelRouter } from "./channel-router.ts";
import type { RefuseTally } from "./queued-messages.ts";
import { settleTurn } from "./settle-turn.ts";
import { systemTurn } from "./system-turns.ts";

const IDENTITY = mapIdentity({ owners: ["riley"] });

const message = (
	id: string,
	channel: ChannelKey = "discord:1",
	extra: Partial<InboundMessage> = {},
): InboundMessage => ({
	channel,
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
});

async function until(done: () => boolean): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (!done()) {
		if (Date.now() > deadline) throw new Error("timed out waiting");
		await Bun.sleep(1);
	}
}

/**
 * A router whose claim runs each message's turn through `settleTurn` until the test ends it from
 * `turns`; a message `reports` first asks for a background turn in another channel, which answers
 * at once. `results` holds what each turn's pipeline got back, and `left` what was refused.
 */
function world(onLeft?: (id: string) => void) {
	const turns = new Map<string, PromiseWithResolvers<TurnResult>>();
	const results = new Map<string, TurnResult>();
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
				const turn = Promise.withResolvers<TurnResult>();
				turns.set(m.messageId, turn);
				results.set(
					m.messageId,
					(await settleTurn(() => turn.promise, "turn")) as TurnResult,
				);
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
						onLeft?.(m.messageId);
						return true;
					},
				}) as ChatSurface,
			sendReply: async () => undefined,
		},
	});
	/** Routes `m` and returns once its turn runs, with the promise of its end. */
	const start = async (m: InboundMessage) => {
		const done = routing.handle(m);
		await until(() => turns.has(m.messageId));
		return { done };
	};
	return { routing, turns, results, left, start };
}

const tally = (): RefuseTally => ({ refused: 0, failed: 0, stopped: false });
const answer = (text: string): TurnResult => ({ ok: true, text });

test("a background turn a message's turn asks for does not answer that message", async () => {
	const { routing, turns, left, start } = world();
	const { done } = await start(message("reports"));
	routing.cutRunning();
	await routing.leaveCut(tally());
	expect(left).toEqual(["reports"]);
	turns.get("reports")?.resolve(answer("late"));
	await done;
});

test("only turns running when the drain limit passes are cut, each left once, and their late answer is stopped", async () => {
	const { routing, turns, results, left, start } = world();
	await routing.leaveCut(tally());
	const { done } = await start(message("a"));
	routing.cutRunning();
	routing.cutRunning();
	await routing.leaveCut(tally());
	await routing.leaveCut(tally());
	expect(left).toEqual(["a"]);
	turns.get("a")?.resolve(answer("late"));
	await done;
	expect(results.get("a")).toMatchObject({ ok: false, stopped: true });
});

test("a turn that failed or was stopped before the cut leaves its message; one that answered does not", async () => {
	for (const [result, expected] of [
		[{ ok: false, error: new Error("boom") }, ["a"]],
		[{ ok: false, error: new Error("stopped"), stopped: true }, ["a"]],
		[answer("answer"), []],
	] as const) {
		const { routing, turns, left, start } = world();
		const { done } = await start(message("a"));
		routing.cutRunning();
		turns.get("a")?.resolve(result as TurnResult);
		await done;
		const counted = tally();
		await routing.leaveCut(counted);
		expect(left).toEqual([...expected]);
		expect(counted.refused).toBe(expected.length);
	}
});

test("once the refusal's time is up, a cut turn not yet reached is not left, and its late answer is posted", async () => {
	const counted = tally();
	const { routing, turns, results, left, start } = world(() => {
		counted.stopped = true;
	});
	const { done: first } = await start(message("a", "discord:1"));
	const { done: second } = await start(message("b", "discord:3"));
	routing.cutRunning();
	await routing.leaveCut(counted);
	expect(left).toEqual(["a"]);
	expect(counted.refused).toBe(1);
	turns.get("a")?.resolve(answer("late"));
	turns.get("b")?.resolve(answer("late"));
	await Promise.all([first, second]);
	expect(results.get("a")).toMatchObject({ ok: false, stopped: true });
	expect(results.get("b")).toEqual(answer("late"));
});

test("a cut turn for a bot's message is not left or counted, and its late answer is posted", async () => {
	const { routing, turns, results, left, start } = world();
	const { done } = await start(
		message("bot", "discord:1", { authorIsBot: true }),
	);
	routing.cutRunning();
	const counted = tally();
	await routing.leaveCut(counted);
	expect(left).toEqual([]);
	expect(counted.refused).toBe(0);
	turns.get("bot")?.resolve(answer("late"));
	await done;
	expect(results.get("bot")).toEqual(answer("late"));
});
