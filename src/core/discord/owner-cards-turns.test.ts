import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { holdChain } from "../holds.ts";
import { messages } from "../i18n/index.ts";
import { silentLogger } from "../log.ts";
import {
	ASK_USER_TOOL,
	askUserExtension,
} from "../runtime/extensions/ask-user.ts";
import { MAIL, MAIL_RULE } from "../runtime/extensions/confirmation-fixture.ts";
import {
	ConfirmationGate,
	canonicalJson,
	confirmationGateExtension,
} from "../runtime/extensions/confirmation-gate.ts";
import { promptSlot } from "../runtime/prompt-slot.ts";
import { TEST_OWNER } from "../testing/owner.ts";
import { lateAnswerMessage } from "./inbound-message.ts";
import { CARD_PREFIX, type LateTurn, OwnerCards } from "./owner-cards.ts";
import {
	fakeChannel,
	json,
	OWNER,
	press,
	tick,
} from "./owner-cards-fixture.ts";

/** Real cards over a fake channel with a short grace period, recording the turns they start. */
function cards() {
	const fake = fakeChannel();
	const resumed: LateTurn[] = [];
	const owner = new OwnerCards({
		ownerId: OWNER,
		channel: fake.channel,
		logger: silentLogger(),
		graceMs: 10,
		resume: (turn) => resumed.push(turn),
	});
	const prompts = owner.prompts("discord:555");
	if (!prompts) throw new Error("no prompts");
	return { fake, owner, prompts, resumed };
}

type ToolCall = (
	event: { toolName: string; toolCallId: string; input: unknown },
	ctx: { signal?: AbortSignal },
) => Promise<{ block: true; reason: string } | undefined>;

describe("a card answered after its turn stopped waiting", () => {
	test("ask_user goes on without the answer; the late answer starts a turn carrying the question and the answer", async () => {
		const { fake, owner, prompts, resumed } = cards();
		const slot = promptSlot();
		slot.bind(prompts, "infra");
		let execute:
			| ((
					id: string,
					params: unknown,
			  ) => Promise<{ content: { text: string }[] }>)
			| undefined;
		let prepare: ((args: unknown) => unknown) | undefined;
		askUserExtension(
			slot,
			TEST_OWNER,
		)({
			registerTool: (tool: {
				name: string;
				execute: typeof execute;
				prepareArguments: typeof prepare;
			}) => {
				if (tool.name === ASK_USER_TOOL) {
					execute = tool.execute;
					prepare = tool.prepareArguments;
				}
			},
		} as unknown as ExtensionAPI);
		const result = await execute?.(
			"call-1",
			prepare?.({
				question: "Which day?",
				options: [{ label: "Saturday" }, { label: "Sunday" }],
			}),
		);
		expect(result?.content[0]?.text).toContain("has not answered yet");
		const pick = press("select", `${CARD_PREFIX}${fake.cardId()}:pick`, {
			values: ["1"],
		});
		await owner.handle(pick.interaction);
		expect(resumed).toHaveLength(1);
		const message = lateAnswerMessage(resumed[0] as LateTurn);
		expect(message).toMatchObject({
			channel: "discord:555",
			authorId: OWNER,
			authorIsBot: false,
			mentionsBot: true,
			actor: { provider: "discord", subject: OWNER },
		});
		expect(message.text).toContain("Question: Which day?");
		expect(message.text).toContain("chose: Sunday");
		expect(json(pick.updates[0])).toContain('"disabled":true');
		// A second press starts nothing more.
		const again = press("select", `${CARD_PREFIX}${fake.cardId()}:pick`, {
			values: ["0"],
		});
		await owner.handle(again.interaction);
		expect(again.replies).toEqual([messages().cardInactive]);
		expect(resumed).toHaveLength(1);
	});

	test("a held action waits; a late approval starts a turn in which exactly that call runs, once", async () => {
		const { fake, owner, prompts, resumed } = cards();
		const gate = new ConfirmationGate(holdChain([MAIL_RULE]), TEST_OWNER);
		const slot = promptSlot();
		slot.bind(prompts, "infra");
		let onCall: ToolCall | undefined;
		confirmationGateExtension(
			gate,
			slot,
		)({
			on: (event: string, handler: ToolCall) => {
				if (event === "tool_call") onCall = handler;
			},
		} as unknown as ExtensionAPI);
		const call = (input: unknown, id = "call-1") =>
			onCall?.({ toolName: MAIL, toolCallId: id, input }, {});
		const send = { to: "a@b.c", subject: "hi" };

		gate.beginTurn("workspace", false);
		const waiting = await call(send);
		expect(waiting?.reason).toContain("Awaiting");
		gate.endTurn();
		expect(gate.pending()).toBeUndefined();

		const yes = press("button", `${CARD_PREFIX}${fake.cardId()}:yes`);
		await owner.handle(yes.interaction);
		await owner.handle(yes.interaction);
		expect(resumed).toHaveLength(1);
		expect(resumed[0]?.text).toContain(`${MAIL} ${canonicalJson(send)}`);

		// The turn the answer started: the identical call runs once; any other is held.
		gate.beginTurn("workspace", false);
		expect(await call({ ...send, subject: "other" }, "call-2")).toMatchObject({
			block: true,
		});
		expect(await call(send, "call-3")).toBeUndefined();
		expect(await call(send, "call-4")).toMatchObject({ block: true });
	});

	test("a call a card approved in its turn knows the card's id until its result is back; one a message confirmed knows none", async () => {
		const { fake, owner, prompts } = cards();
		const gate = new ConfirmationGate(holdChain([MAIL_RULE]), TEST_OWNER);
		const slot = promptSlot();
		slot.bind(prompts, "infra");
		let onCall: ToolCall | undefined;
		confirmationGateExtension(
			gate,
			slot,
		)({
			on: (event: string, handler: ToolCall) => {
				if (event === "tool_call") onCall = handler;
			},
		} as unknown as ExtensionAPI);
		const send = { to: "a@b.c", subject: "hi" };
		gate.beginTurn("workspace", false);
		const running = onCall?.(
			{ toolName: MAIL, toolCallId: "call-1", input: send },
			{},
		);
		await tick();
		const id = fake.cardId();
		await owner.handle(press("button", `${CARD_PREFIX}${id}:yes`).interaction);
		expect(await running).toBeUndefined();
		expect(id).not.toBe("");
		expect(gate.approvedPrompt("call-1")).toBe(id);
		gate.finish("call-1");
		expect(gate.approvedPrompt("call-1")).toBeUndefined();

		// A message that confirms a held call is no card.
		const other = new ConfirmationGate(holdChain([MAIL_RULE]), TEST_OWNER);
		other.beginTurn("workspace", false);
		other.hold(MAIL, send);
		other.endTurn();
		other.beginTurn("workspace", true);
		const decided = await other.decide(MAIL, send);
		expect(decided.reason).toBeUndefined();
		expect(decided.approvedPrompt).toBeUndefined();
	});

	test("a card approved after its turn stopped waiting hands the call that runs in a later turn that card's id", async () => {
		const { fake, owner, prompts } = cards();
		const gate = new ConfirmationGate(holdChain([MAIL_RULE]), TEST_OWNER);
		const slot = promptSlot();
		slot.bind(prompts, "infra");
		let onCall: ToolCall | undefined;
		confirmationGateExtension(
			gate,
			slot,
		)({
			on: (event: string, handler: ToolCall) => {
				if (event === "tool_call") onCall = handler;
			},
		} as unknown as ExtensionAPI);
		const send = { to: "a@b.c", subject: "hi" };
		gate.beginTurn("workspace", false);
		await onCall?.({ toolName: MAIL, toolCallId: "call-1", input: send }, {});
		gate.endTurn();
		const id = fake.cardId();
		await owner.handle(press("button", `${CARD_PREFIX}${id}:yes`).interaction);
		gate.beginTurn("workspace", false);
		expect(
			await onCall?.({ toolName: MAIL, toolCallId: "call-2", input: send }, {}),
		).toBeUndefined();
		expect(gate.approvedPrompt("call-2")).toBe(id);
		// Spent: the identical call again is held again, with no card to name.
		expect(
			await onCall?.({ toolName: MAIL, toolCallId: "call-3", input: send }, {}),
		).toMatchObject({ block: true });
		expect(gate.approvedPrompt("call-3")).toBeUndefined();
	});

	test("a late refusal starts a turn saying so, and the call stays refused", async () => {
		const { fake, owner, prompts, resumed } = cards();
		const gate = new ConfirmationGate(holdChain([MAIL_RULE]), TEST_OWNER);
		gate.beginTurn("workspace", false);
		await gate.decide(MAIL, { to: "a@b.c" }, { prompts, asker: "infra" });
		await owner.handle(
			press("button", `${CARD_PREFIX}${fake.cardId()}:no`).interaction,
		);
		expect(resumed[0]?.text).toContain("declined");
		gate.beginTurn("workspace", false);
		expect(gate.hold(MAIL, { to: "a@b.c" })).toContain("Held");
	});
});
