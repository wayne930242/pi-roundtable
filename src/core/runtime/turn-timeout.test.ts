import { describe, expect, test } from "bun:test";
import type { TurnTimeout } from "../domain/turn-timeout.ts";
import { messages } from "../i18n/index.ts";
import type {
	Approval,
	ApprovalOptions,
	Prompts,
} from "../interactions/prompts.ts";
import type { Logger } from "../log.ts";
import type { TurnActivity } from "./turn-activity.ts";
import { type BudgetClock, runtimeTurnBudget } from "./turn-budget.ts";

const MIN = 60_000;

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

/** A logger that keeps each line's fields and message. */
function recordingLogger() {
	const lines: {
		level: string;
		fields: Record<string, unknown>;
		msg: string;
	}[] = [];
	const at =
		(level: string) => (fields: Record<string, unknown>, msg: string) =>
			lines.push({ level, fields, msg });
	const logger = {
		info: at("info"),
		warn: at("warn"),
		error: at("error"),
		debug: at("debug"),
		child: () => logger,
	} as unknown as Logger;
	return { logger, lines };
}

/** The timeout cards a turn posted, each answerable by hand. */
function fakeCards() {
	const cards: {
		title: string;
		message: string;
		options: ApprovalOptions | undefined;
		answer: (approval: Approval) => void;
	}[] = [];
	const prompts: Prompts = {
		confirm: (title, message, _signal, _minTier, _wait, _details, options) =>
			new Promise<Approval>((answer) => {
				cards.push({ title, message, options, answer });
				options?.supersede?.addEventListener("abort", () =>
					answer("cancelled"),
				);
			}),
		ask: async () => undefined,
	};
	return { prompts, cards };
}

/** Lets an answered card's promise settle. */
const settled = () => new Promise((done) => setTimeout(done, 0));

const BROWSING: TurnActivity = {
	running: [{ tool: "browser_task", ms: 192_000 }],
	compacting: false,
	tools: [
		["web_search", 1],
		["browser_task", 2],
	],
};

function setup(
	options: {
		cards?: boolean;
		turnMaxMs?: number;
		activity?: TurnActivity;
	} = {},
) {
	const { clock, advanceTo } = fakeClock();
	const { logger, lines } = recordingLogger();
	const { prompts, cards } = fakeCards();
	const aborted: TurnTimeout[] = [];
	const budget = runtimeTurnBudget(
		{
			logger,
			turnTimeoutMs: 10 * MIN,
			...(options.turnMaxMs ? { turnMaxMs: options.turnMaxMs } : {}),
		},
		{
			waitedMs: () => 0,
			cards: options.cards === false ? undefined : prompts,
		},
		"discord:1",
		(timeout) => aborted.push(timeout),
		{ activity: { now: () => options.activity ?? BROWSING }, clock },
	);
	return { budget, cards, aborted, lines, advanceTo };
}

describe("a turn at its time limit with a card surface", () => {
	test("posts a card naming the limit, the running tool and the tools so far, and keeps working", () => {
		const { cards, aborted, advanceTo, budget } = setup();
		advanceTo(10 * MIN);
		expect(cards).toHaveLength(1);
		const card = cards[0];
		expect(card?.title).toBe(messages().turnTimeoutTitle);
		expect(card?.message).toContain("browser_task, running for 3 min 12 s");
		expect(card?.message).toContain("web_search · browser_task ×2");
		expect(card?.message).toContain("time limit of 10 min");
		expect(card?.options?.wording?.approve).toBe("Continue");
		expect(card?.options?.wording?.decline).toBe("Cancel");
		expect(aborted).toEqual([]);
		// While it is open the turn is not aborted, and steering waits.
		advanceTo(14 * MIN);
		expect(aborted).toEqual([]);
		expect(budget.capped()).toBe(true);
	});

	test("says when the turn is waiting on the model or compacting", () => {
		const idle = setup({
			activity: { running: [], compacting: false, tools: [] },
		});
		idle.advanceTo(10 * MIN);
		expect(idle.cards[0]?.message).toContain("waiting on the model");
		const compacting = setup({
			activity: { running: [], compacting: true, tools: [] },
		});
		compacting.advanceTo(10 * MIN);
		expect(compacting.cards[0]?.message).toContain(
			"compacting the conversation",
		);
	});

	test("Continue gives a full budget from the answer; the next limit asks again", async () => {
		const { cards, aborted, advanceTo, budget } = setup();
		advanceTo(10 * MIN);
		advanceTo(12 * MIN);
		cards[0]?.answer("approved");
		await settled();
		expect(budget.capped()).toBe(false);
		advanceTo(21 * MIN);
		expect(cards).toHaveLength(1);
		advanceTo(22 * MIN);
		expect(cards).toHaveLength(2);
		expect(aborted).toEqual([]);
	});

	test("Cancel aborts with the reason", async () => {
		const { cards, aborted, advanceTo, lines } = setup();
		advanceTo(10 * MIN);
		advanceTo(11 * MIN);
		cards[0]?.answer("declined");
		await settled();
		expect(aborted).toHaveLength(1);
		expect(aborted[0]).toMatchObject({
			end: "cancelled",
			limit: "turn",
			workedMs: 11 * MIN,
		});
		expect(messages().turnTimedOutNotice(aborted[0] as TurnTimeout)).toContain(
			"Cancelled by the owner after 11 min while browser_task was running",
		);
		expect(
			lines.find((l) => l.msg === "turn timed out; aborting")?.fields,
		).toMatchObject({ end: "cancelled", running: BROWSING.running });
	});

	test("no answer within the grace aborts with the reason and closes the card saying so", async () => {
		const { cards, aborted, advanceTo } = setup();
		advanceTo(10 * MIN);
		advanceTo(15 * MIN - 1);
		expect(aborted).toEqual([]);
		advanceTo(15 * MIN);
		await settled();
		expect(aborted).toHaveLength(1);
		expect(aborted[0]?.end).toBe("unanswered");
		const supersede = cards[0]?.options?.supersede;
		expect(supersede?.aborted).toBe(true);
		expect(String(supersede?.reason)).toContain("No answer in 5 min");
		expect(messages().turnTimedOutNotice(aborted[0] as TurnTimeout)).toContain(
			"No answer to the timeout card in 5 min",
		);
		// A late answer changes nothing.
		cards[0]?.answer("approved");
		expect(aborted).toHaveLength(1);
	});

	test("the turn finishing while the card is open closes it, and nothing is aborted", async () => {
		const { cards, aborted, advanceTo, budget } = setup();
		advanceTo(10 * MIN);
		budget.cancel();
		await settled();
		const supersede = cards[0]?.options?.supersede;
		expect(supersede?.aborted).toBe(true);
		expect(supersede?.reason).toBe(messages().turnTimeoutFinished);
		advanceTo(60 * MIN);
		expect(aborted).toEqual([]);
	});

	test("at the cap Continue extends the cap, again and again", async () => {
		const { cards, aborted, advanceTo } = setup({ turnMaxMs: 15 * MIN });
		advanceTo(10 * MIN);
		cards[0]?.answer("approved");
		await settled();
		// The budget runs to 20 but the cap holds it to 15.
		advanceTo(15 * MIN);
		expect(cards).toHaveLength(2);
		expect(cards[1]?.message).toContain("cap of 15 min");
		advanceTo(16 * MIN);
		cards[1]?.answer("approved");
		await settled();
		advanceTo(25 * MIN);
		expect(cards).toHaveLength(2);
		advanceTo(26 * MIN);
		expect(cards).toHaveLength(3);
		expect(cards[2]?.message).toContain("cap of 26 min");
		cards[2]?.answer("approved");
		await settled();
		advanceTo(36 * MIN);
		expect(cards).toHaveLength(4);
		expect(aborted).toEqual([]);
	});

	test("a card that cannot be shown aborts as before, with the reason", async () => {
		const { cards, aborted, advanceTo } = setup();
		advanceTo(10 * MIN);
		cards[0]?.answer("unavailable");
		await settled();
		expect(aborted[0]?.end).toBe("timeout");
	});
});

describe("a turn at its time limit without a card", () => {
	test("aborts at once; the reason and the log line say why", () => {
		const { cards, aborted, advanceTo, lines } = setup({ cards: false });
		advanceTo(10 * MIN);
		expect(cards).toEqual([]);
		expect(aborted).toHaveLength(1);
		expect(aborted[0]).toMatchObject({
			end: "timeout",
			limit: "turn",
			workedMs: 10 * MIN,
			tools: BROWSING.tools,
		});
		const line = lines.find((l) => l.msg === "turn timed out; aborting");
		expect(line?.fields).toMatchObject({
			limit: "turn",
			workedMs: 10 * MIN,
			running: BROWSING.running,
			tools: BROWSING.tools,
			end: "timeout",
		});
		expect(messages().turnTimedOutNotice(aborted[0] as TurnTimeout)).toBe(
			"⏱️ The turn reached its time limit of 10 min (since it started or since the last message steered into it) and was stopped after 10 min while browser_task was running (3 min 12 s). Tools so far: web_search · browser_task ×2. No one was in the conversation to ask for more time. To let turns like this run longer, turn on long-running for this conversation, or give the schedule a longer time limit.",
		);
	});
});
