import { beforeAll, describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { holdChain } from "../../holds.ts";
import { messages } from "../../i18n/index.ts";
import type { Approval, OwnerPrompts } from "../../interactions/prompts.ts";
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

/** Neutral rules: the mail tool waits for the owner. */
const holds = holdChain([MAIL_RULE]);

const send = { to: "a@b.c", subject: "hi" };

/** Prompts that answer every approval card with `answer`, recording each card. */
function answering(answer: Approval) {
	const cards: { title: string; message: string }[] = [];
	const prompts: OwnerPrompts = {
		confirm: async (title, message) => {
			cards.push({ title, message });
			return answer;
		},
		ask: async () => undefined,
	};
	return { cards, prompts };
}

type ToolCallHandler = (
	event: { toolName: string; toolCallId: string; input: unknown },
	ctx: { signal?: AbortSignal },
) => Promise<{ block: true; reason: string } | undefined>;

type ToolResultHandler = (event: {
	toolCallId: string;
	isError: boolean;
	content: { type: "text"; text: string }[];
}) => { content: { type: "text"; text: string }[] } | undefined;

/** The gate extension's handlers, as Pi would call them. */
function gateHandlers(gate: ConfirmationGate, slot?: PromptSlot) {
	let call: ToolCallHandler | undefined;
	let result: ToolResultHandler | undefined;
	confirmationGateExtension(
		gate,
		slot,
	)({
		on: (event: string, h: ToolCallHandler | ToolResultHandler) => {
			if (event === "tool_call") call = h as ToolCallHandler;
			if (event === "tool_result") result = h as ToolResultHandler;
		},
	} as unknown as ExtensionAPI);
	if (!call || !result) throw new Error("missing handlers");
	const onCall = call;
	return {
		call: (tool: string, input: unknown, toolCallId = "call-1") =>
			onCall(
				{ toolName: tool, toolCallId, input },
				{ signal: new AbortController().signal },
			),
		result,
	};
}

/** The gate extension's tool_call handler, as Pi would call it. */
function gateHandler(gate: ConfirmationGate, slot?: PromptSlot) {
	return gateHandlers(gate, slot).call;
}

describe("in-turn approval", () => {
	test("an approved card runs the call in the same turn and holds nothing", async () => {
		const gate = new ConfirmationGate(holds, OWNER);
		const slot = promptSlot();
		const { cards, prompts } = answering("approved");
		slot.bind(prompts, "helper");
		gate.beginTurn("workspace", false);
		expect(await gateHandler(gate, slot)(MAIL, send)).toBeUndefined();
		gate.endTurn();
		expect(gate.pending()).toBeUndefined();
		expect(cards).toHaveLength(1);
		expect(cards[0]?.title).toBe(messages().confirmTitle("helper"));
		// The same words a held action has, then the exact call.
		expect(cards[0]?.message).toContain("**send an email to a@b.c");
		expect(cards[0]?.message).toContain(MAIL);
		expect(cards[0]?.message).toContain('"to":"a@b.c"');
	});

	test("the result of a call a card approved says so, and only that one", async () => {
		const gate = new ConfirmationGate(holds, OWNER);
		const slot = promptSlot();
		slot.bind(answering("approved").prompts, "helper");
		gate.beginTurn("workspace", false);
		const { call, result } = gateHandlers(gate, slot);
		await call(MAIL, send, "call-1");
		await call("read", {}, "call-2");
		const text = (t: string) => [{ type: "text" as const, text: t }];
		expect(
			result({ toolCallId: "call-1", isError: false, content: text("sent") }),
		).toEqual({
			content: [
				{
					type: "text",
					text: "It was approved on its card and ran; its result follows.",
				},
				{ type: "text", text: "sent" },
			],
		});
		expect(
			result({ toolCallId: "call-2", isError: false, content: text("x") }),
		).toBeUndefined();
		// The mark is spent with the result.
		expect(
			result({ toolCallId: "call-1", isError: false, content: text("sent") }),
		).toBeUndefined();
	});

	test("a call a card approved that then fails is reported as approved and failed", async () => {
		const gate = new ConfirmationGate(holds, OWNER);
		const slot = promptSlot();
		slot.bind(answering("approved").prompts, "helper");
		gate.beginTurn("workspace", false);
		const { call, result } = gateHandlers(gate, slot);
		await call(MAIL, send);
		expect(
			result({
				toolCallId: "call-1",
				isError: true,
				content: [{ type: "text", text: "smtp down" }],
			})?.content[0]?.text,
		).toBe("It was approved on its card and ran, but it failed:");
	});

	test("a declined card refuses the call and holds nothing", async () => {
		const gate = new ConfirmationGate(holds, OWNER);
		const slot = promptSlot();
		slot.bind(answering("declined").prompts, "Assistant");
		gate.beginTurn("workspace", false);
		const result = await gateHandler(gate, slot)(MAIL, send);
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("declined");
		gate.endTurn();
		expect(gate.pending()).toBeUndefined();
	});

	test("a card that could not be shown holds the call for his next message", async () => {
		const gate = new ConfirmationGate(holds, OWNER);
		const slot = promptSlot();
		slot.bind(answering("unavailable").prompts, "Assistant");
		gate.beginTurn("workspace", false);
		const result = await gateHandler(gate, slot)(MAIL, send);
		expect(result?.reason).toContain("Held for Riley's confirmation");
		gate.endTurn();
		expect(gate.pending()?.calls).toHaveLength(1);
	});

	test("an expired card holds the call for his next message, as before", async () => {
		const gate = new ConfirmationGate(holds, OWNER);
		const slot = promptSlot();
		slot.bind(answering("expired").prompts, "Assistant");
		gate.beginTurn("workspace", false);
		const result = await gateHandler(gate, slot)(MAIL, send);
		expect(result?.reason).toContain("Held for Riley's confirmation");
		gate.endTurn();
		expect(gate.pending()?.calls).toHaveLength(1);
	});

	test("the card says the lowest tier that may approve the call, from its tool and its rule", async () => {
		const asked: (string | undefined)[] = [];
		const prompts: OwnerPrompts = {
			confirm: async (_title, _message, _signal, minTier) => {
				asked.push(minTier);
				return "approved";
			},
			ask: async () => undefined,
		};
		const gate = new ConfirmationGate(
			holds,
			OWNER,
			undefined,
			{},
			{
				minTier: () => "member",
				allows: () => true,
			},
		);
		const slot = promptSlot();
		slot.bind(prompts, "Assistant");
		gate.beginTurn("workspace", false);
		await gateHandler(gate, slot)(MAIL, send);
		expect(asked).toEqual(["member"]);
	});

	test("a stopped turn neither runs nor holds the call", async () => {
		const gate = new ConfirmationGate(holds, OWNER);
		const slot = promptSlot();
		slot.bind(answering("cancelled").prompts, "Assistant");
		gate.beginTurn("workspace", false);
		expect((await gateHandler(gate, slot)(MAIL, send))?.block).toBe(true);
		gate.endTurn();
		expect(gate.pending()).toBeUndefined();
	});

	test("with no cards bound, the call is held without asking", async () => {
		const gate = new ConfirmationGate(holds, OWNER);
		const slot = promptSlot();
		const { cards, prompts } = answering("approved");
		slot.bind(undefined, "Assistant");
		gate.beginTurn("workspace", false);
		expect((await gateHandler(gate, slot)(MAIL, send))?.reason).toContain(
			"Held",
		);
		expect(cards).toHaveLength(0);
		// Unbound after the turn: a background turn asks nothing either.
		slot.bind(prompts, "Assistant");
		slot.unbind();
		expect(slot.prompts).toBeUndefined();
		expect((await gateHandler(gate)(MAIL, send))?.reason).toContain("Held");
	});

	test("calls that need no confirmation never show a card", async () => {
		const gate = new ConfirmationGate(holds, OWNER);
		const slot = promptSlot();
		const { cards, prompts } = answering("declined");
		slot.bind(prompts, "Assistant");
		gate.beginTurn("workspace", false);
		expect(await gateHandler(gate, slot)("list-calendars", {})).toBeUndefined();
		expect(cards).toHaveLength(0);
	});

	test("a call released by his text confirmation runs without a card", async () => {
		const gate = new ConfirmationGate(holds, OWNER);
		gate.beginTurn("workspace", false);
		gate.hold(MAIL, send);
		gate.endTurn();
		const slot = promptSlot();
		const { cards, prompts } = answering("declined");
		slot.bind(prompts, "Assistant");
		gate.beginTurn("workspace", true);
		expect(await gateHandler(gate, slot)(MAIL, send)).toBeUndefined();
		expect(cards).toHaveLength(0);
	});
});

describe("a refusal the gate makes", () => {
	/** What the slot recorded for the call after the gate decided it. */
	async function refusalOf(
		answer: Approval | "no card",
		approvedCall = false,
	): Promise<string | undefined> {
		const gate = new ConfirmationGate(holds, OWNER);
		const slot = promptSlot();
		slot.bind(
			answer === "no card" ? undefined : answering(answer).prompts,
			"helper",
		);
		gate.beginTurn("workspace", false);
		const { call } = gateHandlers(gate, slot);
		if (approvedCall) await call("list-calendars", {});
		else await call(MAIL, send);
		return slot.refusalOf("call-1");
	}

	test("is named on the slot by the card's answer, for the progress of the call", async () => {
		expect(await refusalOf("declined")).toBe("declined");
		expect(await refusalOf("expired")).toBe("expired");
		expect(await refusalOf("pending")).toBe("pending");
		expect(await refusalOf("no card")).toBe("held");
		// A card no one could be shown is held, not an unanswered one: it never expired.
		expect(await refusalOf("unavailable")).toBe("held");
	});

	test("is not named for an approved call, a call that needs no card, or a stopped turn", async () => {
		expect(await refusalOf("approved")).toBeUndefined();
		expect(await refusalOf("declined", true)).toBeUndefined();
		expect(await refusalOf("cancelled")).toBeUndefined();
	});

	test("is spent when read, and does not outlive a new turn on the slot", async () => {
		const gate = new ConfirmationGate(holds, OWNER);
		const slot = promptSlot();
		slot.bind(answering("declined").prompts, "helper");
		gate.beginTurn("workspace", false);
		await gateHandlers(gate, slot).call(MAIL, send);
		expect(slot.refusalOf("call-1")).toBe("declined");
		expect(slot.refusalOf("call-1")).toBeUndefined();
		await gateHandlers(gate, slot).call(MAIL, send);
		slot.bind(answering("declined").prompts, "helper");
		expect(slot.refusalOf("call-1")).toBeUndefined();
	});

	test("the gate says why it refused in decide's answer", async () => {
		const gate = new ConfirmationGate(holds, OWNER);
		gate.beginTurn("workspace", false);
		const declined = await gate.decide(MAIL, send, {
			prompts: answering("declined").prompts,
			asker: "helper",
		});
		expect(declined.refused).toBe("declined");
		const approved = await gate.decide(MAIL, send, {
			prompts: answering("approved").prompts,
			asker: "helper",
		});
		expect(approved.refused).toBeUndefined();
	});
});

describe("PromptSlot", () => {
	test("counts the time a turn waits on open cards", async () => {
		const slot = promptSlot();
		let release = (_a: Approval) => {};
		slot.bind(
			{
				confirm: () =>
					new Promise<Approval>((resolve) => {
						release = resolve;
					}),
				ask: async () => undefined,
			},
			"Assistant",
		);
		expect(slot.waitedMs()).toBe(0);
		const answer = slot.prompts?.confirm("t", "m");
		await Bun.sleep(30);
		expect(slot.waitedMs()).toBeGreaterThanOrEqual(25);
		release("approved");
		await answer;
		const waited = slot.waitedMs();
		await Bun.sleep(10);
		expect(slot.waitedMs()).toBe(waited);
		// A new turn starts counting afresh.
		slot.bind(undefined, "Assistant");
		expect(slot.waitedMs()).toBe(0);
	});
});
