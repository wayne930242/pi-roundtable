import { describe, expect, test } from "bun:test";
import type { TurnTimeout } from "../domain/turn-timeout.ts";
import type {
	Approval,
	ApprovalOptions,
	Prompts,
} from "../interactions/prompts.ts";
import type { Logger } from "../log.ts";
import { type BudgetClock, runtimeTurnBudget } from "./turn-budget.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;

/** A clock moved by hand, whose timers fire as it passes them. */
function fakeClock() {
	let now = 0;
	let timers: { at: number; run: () => void }[] = [];
	const clock: BudgetClock = {
		now: () => now,
		schedule: (run, ms) => {
			const timer = { at: now + ms, run };
			timers.push(timer);
			return () => {
				timers = timers.filter((t) => t !== timer);
			};
		},
	};
	const advanceTo = (to: number) => {
		for (;;) {
			const next = timers
				.filter((t) => t.at <= to)
				.sort((a, b) => a.at - b.at)[0];
			if (!next) break;
			timers = timers.filter((t) => t !== next);
			now = next.at;
			next.run();
		}
		now = to;
	};
	return { clock, advanceTo };
}

interface Card {
	message: string;
	options: ApprovalOptions;
	answer(approval: Approval): void;
	/** Why the card was closed without an answer, as its footer: the supersede signal's reason. */
	closedWith(): string | undefined;
}

/** The runtime's budget in a conversation whose yolo mode `yolo` says, over a fake clock. */
function yoloTurn(options: {
	yolo: () => boolean;
	yoloCardMs?: number;
	ceilingMs?: number;
}) {
	const { clock, advanceTo } = fakeClock();
	const cards: Card[] = [];
	const logged: string[] = [];
	const aborted: TurnTimeout[] = [];
	const prompts: Prompts = {
		confirm: (_title, message, _signal, _minTier, _wait, _details, opts) =>
			new Promise<Approval>((resolve) => {
				const supersede = opts?.supersede;
				supersede?.addEventListener("abort", () => resolve("cancelled"), {
					once: true,
				});
				cards.push({
					message,
					options: opts as ApprovalOptions,
					answer: resolve,
					closedWith: () =>
						supersede?.aborted ? String(supersede.reason) : undefined,
				});
			}),
		ask: async () => undefined,
	};
	const logger = {
		info: (_fields: unknown, line: string) => logged.push(line),
		warn: () => {},
		error: () => {},
		debug: () => {},
		child: () => logger,
	} as unknown as Logger;
	const budget = runtimeTurnBudget(
		{ logger, turnTimeoutMs: 10 * MIN, turnTimeoutCardMs: 5 * MIN },
		{ waitedMs: () => 0, cards: prompts },
		"app:agent.guide",
		(timeout) => aborted.push(timeout),
		{
			activity: { now: () => ({ running: [], compacting: false, tools: [] }) },
			clock,
			yolo: options.yolo,
			...(options.yoloCardMs ? { yoloCardMs: options.yoloCardMs } : {}),
			...("ceilingMs" in options
				? options.ceilingMs === undefined
					? {}
					: { ceilingMs: options.ceilingMs }
				: { ceilingMs: 4 * HOUR }),
		},
	);
	return { budget, cards, logged, aborted, advanceTo };
}

describe("the timeout card in a yolo conversation", () => {
	test("still posts, waits one minute by default, and unanswered goes on as Continue would", () => {
		const t = yoloTurn({ yolo: () => true });
		t.advanceTo(10 * MIN);
		expect(t.cards).toHaveLength(1);
		const [card] = t.cards;
		expect(card?.options.purpose).toBe("turn-timeout");
		expect(card?.message).toContain(
			"Yolo mode is on: with no answer in 1 min it keeps going by itself.",
		);
		t.advanceTo(11 * MIN - 1);
		expect(card?.closedWith()).toBeUndefined();
		t.advanceTo(11 * MIN);
		expect(t.aborted).toEqual([]);
		expect(card?.closedWith()).toBe(
			"⏱️ No answer in 1 min; yolo mode is on, so the turn continued automatically.",
		);
		expect(t.logged).toContain(
			"yolo mode continued the turn; the timeout card went unanswered",
		);
		// A full budget again from minute 11: the next card comes at minute 21.
		t.advanceTo(21 * MIN - 1);
		expect(t.cards).toHaveLength(1);
		t.advanceTo(21 * MIN);
		expect(t.cards).toHaveLength(2);
	});

	test("its wait follows the configuration", () => {
		const t = yoloTurn({ yolo: () => true, yoloCardMs: 2 * MIN });
		t.advanceTo(10 * MIN);
		expect(t.cards[0]?.message).toContain("with no answer in 2 min");
		t.advanceTo(11 * MIN);
		expect(t.cards[0]?.closedWith()).toBeUndefined();
		t.advanceTo(12 * MIN);
		expect(t.cards[0]?.closedWith()).toContain("continued automatically");
		expect(t.aborted).toEqual([]);
	});

	test("Cancel still stops the turn", async () => {
		const t = yoloTurn({ yolo: () => true });
		t.advanceTo(10 * MIN);
		t.cards[0]?.answer("declined");
		await Bun.sleep(0);
		expect(t.aborted).toHaveLength(1);
		expect(t.aborted[0]).toMatchObject({ end: "cancelled" });
	});

	test("unanswered extensions stop at the long-running cap, where the card is the usual one and stops", () => {
		const t = yoloTurn({ yolo: () => true, ceilingMs: 30 * MIN });
		// Cards at 10, 21: each unanswered for a minute, each extended to a full budget.
		t.advanceTo(29 * MIN);
		expect(t.cards).toHaveLength(2);
		expect(t.aborted).toEqual([]);
		// The third extension is held to the 30-minute ceiling, where the limit fires as the cap.
		t.advanceTo(30 * MIN);
		expect(t.cards).toHaveLength(3);
		const last = t.cards[2];
		expect(last?.message).toContain("With no answer in 5 min it stops.");
		expect(last?.message).not.toContain("Yolo mode");
		t.advanceTo(35 * MIN);
		expect(last?.closedWith()).toBe(
			"⏱️ No answer in 5 min; the turn was stopped.",
		);
		expect(t.aborted).toHaveLength(1);
		expect(t.aborted[0]).toMatchObject({
			end: "unanswered",
			limit: "turnMax",
			graceMs: 5 * MIN,
		});
		expect(t.aborted[0]?.autoContinue).toBeUndefined();
	});

	test("without a ceiling the card is the usual one", () => {
		const t = yoloTurn({ yolo: () => true, ceilingMs: undefined });
		t.advanceTo(10 * MIN);
		expect(t.cards[0]?.message).toContain("With no answer in 5 min it stops.");
		t.advanceTo(15 * MIN);
		expect(t.aborted).toHaveLength(1);
	});

	test("outside yolo nothing changes: the card waits five minutes and then stops the turn", () => {
		const t = yoloTurn({ yolo: () => false });
		t.advanceTo(10 * MIN);
		expect(t.cards[0]?.message).toContain("With no answer in 5 min it stops.");
		t.advanceTo(14 * MIN);
		expect(t.aborted).toEqual([]);
		t.advanceTo(15 * MIN);
		expect(t.aborted).toHaveLength(1);
		expect(t.aborted[0]).toMatchObject({ end: "unanswered", graceMs: 5 * MIN });
	});

	test("yolo is read when the limit fires: turned on later, the next card goes on by itself", async () => {
		let yolo = false;
		const t = yoloTurn({ yolo: () => yolo });
		t.advanceTo(10 * MIN);
		t.cards[0]?.answer("approved");
		await Bun.sleep(0);
		yolo = true;
		t.advanceTo(20 * MIN);
		expect(t.cards[1]?.message).toContain("keeps going by itself");
	});
});
