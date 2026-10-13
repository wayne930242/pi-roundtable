import { expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { defineTool, type ToolTurn } from "../define.ts";
import { holdChain } from "../holds.ts";
import { silentLogger } from "../log.ts";
import { ConfirmationGate } from "../runtime/extensions/confirmation-gate.ts";
import { confirmationGateExtension } from "../runtime/extensions/confirmation-gate-extension.ts";
import { promptSlot } from "../runtime/prompt-slot.ts";
import { TEST_OWNER } from "../testing/owner.ts";
import { CARD_PREFIX, OwnerCards } from "./owner-cards.ts";
import { fakeChannel, json, press, tick } from "./owner-cards-fixture.ts";

type Handler = (
	event: { toolName: string; toolCallId: string; input: unknown },
	ctx: { signal?: AbortSignal },
) => Promise<{ block: true; reason: string } | undefined>;

const BODY = "Hello Dana,\nthe parts ship on Friday.";

const tool = defineTool({
	name: "message_send",
	description: "Send a message.",
	parameters: Type.Object({ to: Type.String(), body: Type.String() }),
	minTier: "member",
	hold: ({ to, body }) => ({
		text: `Send a message to ${to}`,
		copy: { label: "Copy message", text: body },
	}),
	run: () => ({ text: "sent" }),
});

/** A gate holding the tool, whose cards go to a fake Discord channel. */
function setup() {
	const fake = fakeChannel();
	const cards = new OwnerCards({
		ownerId: "100000000000000001",
		channel: fake.channel,
		logger: silentLogger(),
	});
	const prompts = cards.prompts("discord:555");
	if (!prompts) throw new Error("no prompts for a Discord channel");
	const slot = promptSlot();
	slot.bind(prompts, "helper");
	const gate = new ConfirmationGate(
		holdChain(tool.hold ? [tool.hold] : []),
		TEST_OWNER,
	);
	gate.beginTurn("workspace", false);
	let call: Handler | undefined;
	confirmationGateExtension(
		gate,
		slot,
		(signal) => ({ signal }) as unknown as ToolTurn,
	)({
		on: (event: string, h: Handler) => {
			if (event === "tool_call") call = h;
		},
	} as unknown as ExtensionAPI);
	if (!call) throw new Error("missing handler");
	return { fake, cards, call };
}

test("a held tool call's approval card carries the copy button, pressing it answers nothing, and the owner's yes still releases the call", async () => {
	const { fake, cards, call } = setup();
	const result = call(
		{
			toolName: "message_send",
			toolCallId: "c1",
			input: { to: "Dana", body: BODY },
		},
		{ signal: new AbortController().signal },
	);
	await tick();
	await tick();
	const card = json(fake.sent[0]);
	expect(card).toContain("Send a message to Dana");
	expect(card).toContain("Copy message");
	const id = fake.cardId();
	const copy = press("button", `${CARD_PREFIX}${id}:copy`, { user: "1" });
	expect(await cards.handle(copy.interaction)).toBe(true);
	expect(copy.replies).toEqual([`\`\`\`\n${BODY}\n\`\`\``]);
	let settled = false;
	void result.then(() => {
		settled = true;
	});
	await tick();
	expect(settled).toBe(false);
	await cards.handle(press("button", `${CARD_PREFIX}${id}:yes`).interaction);
	expect(await result).toBeUndefined();
});
