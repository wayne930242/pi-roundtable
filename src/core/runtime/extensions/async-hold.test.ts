import { beforeAll, describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ToolTurn } from "../../define.ts";
import type { HoldRule } from "../../holds.ts";
import { holdChain } from "../../holds.ts";
import { messages } from "../../i18n/index.ts";
import type { ApprovalDetails, Prompts } from "../../interactions/prompts.ts";
import type { Speaker } from "../../speakers.ts";
import { useTestLocale } from "../../testing/locale.ts";
import { TEST_OWNER as OWNER } from "../../testing/owner.ts";
import { type PromptSlot, promptSlot } from "../prompt-slot.ts";
import { MAIL, MAIL_RULE } from "./confirmation-fixture.ts";
import {
	ConfirmationGate,
	confirmationGateExtension,
} from "./confirmation-gate.ts";

useTestLocale();
beforeAll(() => useTestLocale());

const SAM: Speaker = {
	id: "7",
	name: "Sam",
	tier: "member",
	principalId: "p_sam",
};

/** A turn as the gate hands it to a hold: Sam speaks, in a web channel. */
function turnOf(signal: AbortSignal | undefined): ToolTurn {
	return {
		speaker: SAM,
		channel: "web:1",
		agent: undefined,
		signal,
		attachFile: () => undefined,
		attachment: async () => {
			throw new Error("no attachments");
		},
	};
}

/** A rule that looks the recipient up before it describes the call. */
function lookup(
	describe: (
		input: Record<string, unknown>,
		turn: ToolTurn,
	) => string | undefined | Promise<string | undefined>,
): HoldRule {
	return {
		name: "lookup",
		describe: (tool) => (tool === MAIL ? "send an email" : undefined),
		describeInTurn: (tool, input, _context, turn) =>
			tool === MAIL ? describe(input, turn) : undefined,
	};
}

/** Prompts that answer every card with `answer`, recording each card's text and details in order. */
function recording(answer: "approved" | "expired" = "expired") {
	const cards: { message: string; details: ApprovalDetails | undefined }[] = [];
	const prompts: Prompts = {
		confirm: async (_title, message, _signal, _tier, _wait, details) => {
			cards.push({ message, details });
			return answer;
		},
		ask: async () => undefined,
	};
	return { cards, prompts };
}

type Handler = (
	event: { toolName: string; toolCallId: string; input: unknown },
	ctx: { signal?: AbortSignal },
) => Promise<{ block: true; reason: string } | undefined>;

/** The gate extension's tool_call handler, wired with the turn the gate hands to holds. */
function handlerOf(gate: ConfirmationGate, slot: PromptSlot): Handler {
	let call: Handler | undefined;
	confirmationGateExtension(
		gate,
		slot,
		turnOf,
	)({
		on: (event: string, h: Handler) => {
			if (event === "tool_call") call = h;
		},
	} as unknown as ExtensionAPI);
	if (!call) throw new Error("missing handler");
	return call;
}

/** A gate, its handler, and the cards that open, for a hold rule. */
function setup(rule: HoldRule, timeoutMs?: number) {
	const gate = new ConfirmationGate(
		holdChain([rule]),
		OWNER,
		undefined,
		{},
		undefined,
		undefined,
		timeoutMs,
	);
	const slot = promptSlot();
	const { cards, prompts } = recording();
	slot.bind(prompts, "helper");
	gate.beginTurn("workspace", false);
	return { gate, cards, call: handlerOf(gate, slot) };
}

const send = (to: string) => ({ to });
const event = (to: string, toolCallId = "call-1") => ({
	toolName: MAIL,
	toolCallId,
	input: send(to),
});

describe("a hold that looks things up", () => {
	test("its text is on the card and in the card's details, and the hold sees the turn's speaker", async () => {
		const seen: (Speaker | undefined)[] = [];
		const { cards, call } = setup(
			lookup(async (input, turn) => {
				seen.push(turn.speaker);
				await Bun.sleep(5);
				return `send an email to ${String(input.to)} (Dana Reyes)`;
			}),
		);
		const result = await call(event("dana"), {
			signal: new AbortController().signal,
		});
		expect(result?.block).toBe(true);
		expect(seen).toEqual([SAM]);
		expect(cards).toHaveLength(1);
		expect(cards[0]?.message).toContain(
			"**send an email to dana (Dana Reyes)**",
		);
		expect(cards[0]?.details?.action).toBe(
			"send an email to dana (Dana Reyes)",
		);
	});

	test("it is held for the next message with the looked-up text when no card can be shown", async () => {
		const gate = new ConfirmationGate(
			holdChain([lookup(async () => "send an email to Dana Reyes")]),
			OWNER,
		);
		gate.beginTurn("workspace", false);
		const decision = await gate.decide(MAIL, send("dana"), undefined, {
			toolTurn: turnOf,
		});
		expect(decision.refused).toBe("held");
		expect(decision.reason).toContain("send an email to Dana Reyes");
		expect(gate.pending()?.calls).toMatchObject([
			{ tool: MAIL, action: "send an email to Dana Reyes" },
		]);
	});

	test("its signal is the turn's: stopping the turn aborts it", async () => {
		const signals: (AbortSignal | undefined)[] = [];
		const { call } = setup(
			lookup((_input, turn) => {
				signals.push(turn.signal);
				return new Promise<string>(() => undefined);
			}),
		);
		const stop = new AbortController();
		const pending = call(event("dana"), { signal: stop.signal });
		await Bun.sleep(5);
		expect(signals[0]?.aborted).toBe(false);
		stop.abort();
		await pending;
		expect(signals[0]?.aborted).toBe(true);
	});

	test("a rejection falls back to a generic description, and the call is still held", async () => {
		const { gate, cards, call } = setup(
			lookup(async () => {
				throw new Error("directory is down");
			}),
		);
		const result = await call(event("dana"), {
			signal: new AbortController().signal,
		});
		expect(result?.block).toBe(true);
		expect(cards).toHaveLength(1);
		expect(cards[0]?.details?.action).toBe(messages().holdGeneric(MAIL));
		expect(cards[0]?.message).toContain(`**${messages().holdGeneric(MAIL)}**`);
		// The exact call is still on the card, so the owner sees what they approve.
		expect(cards[0]?.message).toContain('"to":"dana"');
		gate.endTurn();
	});

	test("a throw before it returns a promise falls back the same way", async () => {
		const { cards, call } = setup(
			lookup(() => {
				throw new Error("not ready");
			}),
		);
		await call(event("dana"), { signal: new AbortController().signal });
		expect(cards[0]?.details?.action).toBe(messages().holdGeneric(MAIL));
	});

	test("a hold that outlasts the timeout falls back to the generic description, and its signal aborts", async () => {
		let signal: AbortSignal | undefined;
		const { cards, call } = setup(
			lookup((_input, turn) => {
				signal = turn.signal;
				return new Promise<string>(() => undefined);
			}),
			20,
		);
		const started = Date.now();
		const result = await call(event("dana"), {
			signal: new AbortController().signal,
		});
		expect(Date.now() - started).toBeLessThan(2_000);
		expect(result?.block).toBe(true);
		expect(cards[0]?.details?.action).toBe(messages().holdGeneric(MAIL));
		expect(signal?.aborted).toBe(true);
	});

	test("a hold that answers undefined lets the call run", async () => {
		const { cards, call } = setup(lookup(async () => undefined));
		expect(
			await call(event("dana"), { signal: new AbortController().signal }),
		).toBeUndefined();
		expect(cards).toEqual([]);
	});

	test("a stopped turn opens no card and holds nothing", async () => {
		const { gate, cards, call } = setup(
			lookup(async () => {
				await Bun.sleep(30);
				return "send an email to Dana Reyes";
			}),
		);
		const stop = new AbortController();
		const pending = call(event("dana"), { signal: stop.signal });
		await Bun.sleep(5);
		stop.abort();
		const result = await pending;
		expect(result).toEqual({ block: true, reason: "The turn was stopped." });
		await Bun.sleep(40);
		expect(cards).toEqual([]);
		expect(gate.pending()).toBeUndefined();
	});

	test("a turn already stopped opens no card either", async () => {
		const { cards, call } = setup(lookup(async () => "send an email"));
		const stop = new AbortController();
		stop.abort();
		const result = await call(event("dana"), { signal: stop.signal });
		expect(result?.reason).toBe("The turn was stopped.");
		expect(cards).toEqual([]);
	});

	test("a hold that rejects after the turn stopped leaves nothing unhandled", async () => {
		const { cards, call } = setup(
			lookup(async () => {
				await Bun.sleep(10);
				throw new Error("directory is down");
			}),
		);
		const stop = new AbortController();
		const pending = call(event("dana"), { signal: stop.signal });
		stop.abort();
		expect((await pending)?.reason).toBe("The turn was stopped.");
		await Bun.sleep(30);
		expect(cards).toEqual([]);
	});

	test("an approved call is released in the confirmed turn without a card", async () => {
		const rule = lookup(async () => "send an email to Dana Reyes");
		const gate = new ConfirmationGate(holdChain([rule]), OWNER);
		gate.beginTurn("workspace", false);
		await gate.decide(MAIL, send("dana"), undefined, { toolTurn: turnOf });
		gate.endTurn();
		gate.beginTurn("workspace", true);
		expect(
			await gate.decide(MAIL, send("dana"), undefined, { toolTurn: turnOf }),
		).toEqual({});
	});

	test("parallel calls keep their own descriptions, and are held and shown in the order they were made", async () => {
		const { gate, cards, call } = setup(
			lookup(async (input) => {
				// The first call's lookup is the slowest.
				await Bun.sleep(input.to === "first" ? 40 : 1);
				return `send an email to ${String(input.to)}`;
			}),
		);
		const signal = new AbortController().signal;
		await Promise.all([
			call(event("first", "c1"), { signal }),
			call(event("second", "c2"), { signal }),
			call(event("third", "c3"), { signal }),
		]);
		expect(cards.map((card) => card.details?.action)).toEqual([
			"send an email to first",
			"send an email to second",
			"send an email to third",
		]);
		expect(cards.map((card) => card.details?.input)).toEqual([
			send("first"),
			send("second"),
			send("third"),
		]);
		gate.endTurn();
	});
});

describe("a hold that does not look things up", () => {
	test("a synchronous hold gives the same card as before and resolves without waiting", async () => {
		const { cards, call } = setup(MAIL_RULE);
		const result = call(event("a@b.c"), {
			signal: new AbortController().signal,
		});
		expect((await result)?.block).toBe(true);
		expect(cards[0]?.message).toContain("**send an email to a@b.c**");
		expect(cards[0]?.details?.action).toBe("send an email to a@b.c");
	});

	test("a rule with describeInTurn that answers at once is not awaited out of order", async () => {
		const { cards, call } = setup(lookup(() => "send an email to Dana"));
		const signal = new AbortController().signal;
		await Promise.all([
			call(event("a", "c1"), { signal }),
			call(event("b", "c2"), { signal }),
		]);
		expect(cards).toHaveLength(2);
		expect(cards[0]?.details?.input).toEqual(send("a"));
	});
});
