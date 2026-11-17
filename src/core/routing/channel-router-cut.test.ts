import { expect, test } from "bun:test";
import type { ChannelClaim, InboundMessage } from "../contract/channels.ts";
import type { ChatSurface } from "../contract/surface.ts";
import type { TurnResult } from "../domain/conversation.ts";
import { AgentRunError } from "../domain/errors.ts";
import type { ChannelKey } from "../domain/sessions.ts";
import { HostStoppingError } from "../kernel/errors.ts";
import { silentLogger } from "../kernel/log.ts";
import { PERSONAL_TARGET } from "../shared/personal-target.ts";
import { mapIdentity } from "../testing/map-identity.ts";
import { ChannelQueue } from "./channel-queue.ts";
import { ChannelRouter } from "./channel-router.ts";
import type { RefuseTally } from "./queued-messages.ts";
import { settleTurn } from "./settle-turn.ts";
import { systemTurn } from "./system-turns.ts";
import { currentRecord } from "./turn-records.ts";

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
	const queue = new ChannelQueue();
	/** Runs the message's turn through `settleTurn` until the test ends it. */
	const answer = async (id: string) => {
		const turn = Promise.withResolvers<TurnResult>();
		turns.set(id, turn);
		results.set(
			id,
			(await settleTurn(() => turn.promise, "turn")) as TurnResult,
		);
	};
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
				// Answered in a queue task of a thread it opens, not waited for, as a plugin's claim may.
				if (m.messageId.startsWith("detached"))
					void queue.run("discord:9", async () => {
						// Its turn starts only after the admission ended, as one that records its conversation first.
						await Bun.sleep(2);
						await answer(m.messageId);
					});
				else await answer(m.messageId);
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
		queue,
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
const answered = (text: string): TurnResult => ({ ok: true, text });

test("a background turn a message's turn asks for does not answer that message", async () => {
	const { routing, turns, left, start } = world();
	const { done } = await start(message("reports"));
	routing.cutRunning();
	await routing.leaveCut(tally());
	expect(left).toEqual(["reports"]);
	turns.get("reports")?.resolve(answered("late"));
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
	turns.get("a")?.resolve(answered("late"));
	await done;
	expect(results.get("a")).toMatchObject({ ok: false, stopped: true });
});

test("a turn that fails or is stopped during the grace leaves its message; one that answers does not", async () => {
	for (const [result, expected] of [
		[{ ok: false, error: new Error("boom") }, ["a"]],
		[{ ok: false, error: new Error("stopped"), stopped: true }, ["a"]],
		[answered("answer"), []],
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
	turns.get("a")?.resolve(answered("late"));
	turns.get("b")?.resolve(answered("late"));
	await Promise.all([first, second]);
	expect(results.get("a")).toMatchObject({ ok: false, stopped: true });
	expect(results.get("b")).toEqual(answered("late"));
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
	turns.get("bot")?.resolve(answered("late"));
	await done;
	expect(results.get("bot")).toEqual(answered("late"));
});

test("a turn the admission queues without waiting for it answers its message, or leaves it when cut", async () => {
	for (const [result, expected] of [
		[answered("answer"), []],
		[undefined, ["detached"]],
	] as const) {
		const { routing, turns, left, start } = world();
		await start(message("detached"));
		routing.cutRunning();
		if (result) turns.get("detached")?.resolve(result);
		await Bun.sleep(0);
		await routing.leaveCut(tally());
		expect(left).toEqual([...expected]);
		turns.get("detached")?.resolve(answered("late"));
	}
});

test("a message steered into a turn after an earlier turn of it answered is left when the turn is cut", async () => {
	const left: string[] = [];
	const results = new Map<string, TurnResult>();
	let steer = false;
	// The admission runs two turns, as a group round of two members does.
	const first = Promise.withResolvers<TurnResult>();
	const second = Promise.withResolvers<TurnResult>();
	const claim: ChannelClaim = {
		name: "rounds",
		priority: 1,
		owns: () => true,
		admit: (m) => ({
			kind: "turn",
			busy: {
				steer: async () => steer,
				react: async () => undefined,
				unreact: async () => undefined,
			},
			run: async () => {
				await settleTurn(() => first.promise, "member one");
				results.set(
					m.messageId,
					(await settleTurn(() => second.promise, "member two")) as TurnResult,
				);
			},
			failure: "failed",
		}),
		startFresh: async () => "rounds",
	};
	const rounds = new ChannelRouter({
		claims: [claim],
		targets: () => undefined,
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
	const done = rounds.handle(message("a"));
	await Bun.sleep(0);
	first.resolve(answered("one"));
	await Bun.sleep(1);
	steer = true;
	await rounds.handle(message("b"));
	rounds.cutRunning();
	await rounds.leaveCut(tally());
	expect(left).toEqual(["b"]);
	second.resolve(answered("two"));
	await done;
	expect(results.get("a")).toMatchObject({ stopped: true });
});

/** A router over `queue` whose one claim runs `run` for every message and steers when `steers`. */
function plainRouter(
	queue: ChannelQueue,
	run: (m: InboundMessage) => Promise<void>,
	options: { steers?: boolean; warned?: string[] } = {},
) {
	const left: string[] = [];
	const logger = silentLogger();
	if (options.warned) {
		const warned = options.warned;
		logger.warn = ((...args: unknown[]) => {
			warned.push(String(args.at(-1)));
		}) as typeof logger.warn;
	}
	const routing = new ChannelRouter({
		claims: [
			{
				name: "plain",
				priority: 0,
				owns: () => true,
				admit: (m) => ({
					kind: "turn",
					busy: {
						steer: async () => options.steers === true,
						react: async () => undefined,
						unreact: async () => undefined,
					},
					run: () => run(m),
					failure: "failed",
				}),
				startFresh: async () => "plain",
			},
		],
		targets: () => undefined,
		queue,
		logger,
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
	return { routing, left };
}

/** A router whose admission queues its turn on `discord:9` behind a busy task there, without waiting. */
function queuedBehind() {
	const queue = new ChannelQueue();
	const ahead = Promise.withResolvers<void>();
	const turn = Promise.withResolvers<TurnResult>();
	const busy = queue.run("discord:9", () => ahead.promise);
	let started = false;
	const { routing, left } = plainRouter(queue, async () => {
		void queue
			.run("discord:9", async () => {
				started = true;
				await settleTurn(() => turn.promise, "turn");
			})
			.catch(() => undefined);
	});
	return { queue, ahead, turn, busy, routing, left, started: () => started };
}

test("a turn the admission queued and that has not started keeps the message's record open, so a cut leaves it", async () => {
	const w = queuedBehind();
	await w.routing.handle(message("a"));
	expect(w.started()).toBe(false);
	w.routing.cutRunning();
	await w.routing.leaveCut(tally());
	expect(w.left).toEqual(["a"]);
	w.ahead.resolve();
	await w.busy;
	w.turn.resolve(answered("late"));
});

test("a turn the admission queued that the closed queue refuses leaves the message, cut or not", async () => {
	const w = queuedBehind();
	await w.routing.handle(message("a"));
	w.queue.close();
	w.ahead.resolve();
	await w.busy;
	await Bun.sleep(0);
	expect(w.started()).toBe(false);
	await w.routing.leaveCut(tally());
	expect(w.left).toEqual(["a"]);
});

test("a turn the stopping host refuses before it ran leaves its message once, whenever that was, and posts no failure", async () => {
	for (const refuse of ["result", "throw", "thrown in a turn"] as const) {
		const queue = new ChannelQueue();
		const results: unknown[] = [];
		const { routing, left } = plainRouter(queue, async () => {
			if (refuse === "throw") throw new HostStoppingError();
			results.push(
				await settleTurn(async () => {
					// As `context.turns` refuses a turn asked for once the host stops.
					if (refuse === "thrown in a turn") throw new HostStoppingError();
					// As the runtime answers one.
					return {
						ok: false,
						error: new AgentRunError(new HostStoppingError().message),
					};
				}, "turn"),
			);
		});
		await routing.handle(message("a"));
		// Not running at the drain limit: no cut is needed.
		await routing.leaveCut(tally());
		expect(left).toEqual(["a"]);
		if (refuse !== "throw")
			expect(results).toEqual([expect.objectContaining({ stopped: true })]);
	}
});

test("work an admission set up that runs after its work ended changes nothing, such as a timer's turn", async () => {
	const queue = new ChannelQueue();
	const timer = Promise.withResolvers<void>();
	const fired = Promise.withResolvers<unknown>();
	const { routing, left } = plainRouter(queue, async () => {
		void timer.promise.then(async () => {
			fired.resolve(
				await settleTurn(async () => {
					throw new HostStoppingError();
				}, "turn"),
			);
		});
	});
	await routing.handle(message("a"));
	timer.resolve();
	// Its refusal stays a failure that asks to try again: nothing promises an answer after the restart.
	expect(await fired.promise).toEqual({
		ok: false,
		error: new AgentRunError(new HostStoppingError().message),
	});
	routing.cutRunning();
	await routing.leaveCut(tally());
	expect(left).toEqual([]);
});

test("what a cut turn handed on is dropped only when its message is left", async () => {
	for (const [author, stopped, expected] of [
		[{}, false, ["dropped"]],
		[{ authorIsBot: true }, false, []],
		[{}, true, []],
	] as const) {
		const queue = new ChannelQueue();
		const turn = Promise.withResolvers<TurnResult>();
		const dropped: string[] = [];
		const { routing } = plainRouter(queue, async () => {
			currentRecord()?.onLeave(async () => void dropped.push("dropped"));
			await settleTurn(() => turn.promise, "turn");
		});
		const done = routing.handle(message("a", "discord:1", author));
		await Bun.sleep(0);
		routing.cutRunning();
		const counted = tally();
		counted.stopped = stopped;
		const { dropping } = await routing.leaveCut(counted);
		await dropping;
		expect(dropped).toEqual([...expected]);
		turn.resolve(answered("late"));
		await done;
	}
});

test("a message steered into a turn routing did not start is logged as one a shutdown cannot refuse", async () => {
	const queue = new ChannelQueue();
	const warned: string[] = [];
	const hold = Promise.withResolvers<void>();
	const { routing } = plainRouter(queue, async () => undefined, {
		steers: true,
		warned,
	});
	const plugin = queue.run("discord:1", () => hold.promise);
	await routing.handle(message("a"));
	expect(warned).toContain(
		"message steered into a turn routing did not start; a shutdown that cuts that turn does not refuse it",
	);
	hold.resolve();
	await plugin;
});

test("telling a cut turn's channel does not wait for what it handed on to be dropped", async () => {
	const queue = new ChannelQueue();
	const turn = Promise.withResolvers<TurnResult>();
	const slow = Promise.withResolvers<void>();
	const { routing, left } = plainRouter(queue, async () => {
		currentRecord()?.onLeave(() => slow.promise);
		await settleTurn(() => turn.promise, "turn");
	});
	const done = routing.handle(message("a"));
	await Bun.sleep(0);
	routing.cutRunning();
	const { dropping } = await routing.leaveCut(tally());
	expect(left).toEqual(["a"]);
	let dropped = false;
	void dropping.then(() => {
		dropped = true;
	});
	await Bun.sleep(1);
	expect(dropped).toBe(false);
	slow.resolve();
	await dropping;
	turn.resolve(answered("late"));
	await done;
});

test("a bare settleTurn in a queue task the admission started is waited for in that task's channel only", async () => {
	const queue = new ChannelQueue();
	const turn = Promise.withResolvers<TurnResult>();
	const { routing } = plainRouter(queue, async () => {
		void queue.run("discord:9", () => settleTurn(() => turn.promise, "turn"));
	});
	await routing.handle(message("a"));
	await Bun.sleep(0);
	expect(routing.busy()).toEqual(["discord:9"]);
	turn.resolve(answered("done"));
	await until(() => routing.busy().length === 0);
});
