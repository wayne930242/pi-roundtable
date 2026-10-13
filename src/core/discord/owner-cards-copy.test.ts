import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MessageFlags } from "discord.js";
import { messages } from "../i18n/index.ts";
import { silentLogger } from "../log.ts";
import { COPY_TEXT_LIMIT } from "./card-copies.ts";
import {
	CARD_PREFIX,
	OwnerCards,
	type OwnerCardsOptions,
} from "./owner-cards.ts";
import {
	fakeChannel,
	json,
	OWNER,
	press,
	tick,
} from "./owner-cards-fixture.ts";

const STRANGER = "1";

function setup(options: Partial<OwnerCardsOptions> = {}) {
	const fake = fakeChannel();
	const cards = new OwnerCards({
		ownerId: OWNER,
		channel: fake.channel,
		logger: silentLogger(),
		...options,
	});
	const prompts = cards.prompts("discord:555");
	if (!prompts) throw new Error("no prompts for a Discord channel");
	return { fake, cards, prompts };
}

const DETAILS = (copy?: { label?: string; text: string }) => ({
	action: "run it",
	tool: "bash",
	input: {},
	...(copy ? { copy } : {}),
});

/** Asks an approval that offers `copy`, and waits until its card is posted. */
async function approval(
	harness: ReturnType<typeof setup>,
	copy?: { label?: string; text: string },
) {
	const answer = harness.prompts.confirm(
		"t",
		"m",
		undefined,
		undefined,
		undefined,
		DETAILS(copy),
	);
	await tick();
	return { answer, id: harness.fake.cardId() };
}

test("an approval with a copy text has a copy button beside run and cancel; the text is not in its custom id", async () => {
	const harness = setup();
	const text = "ssh host 'uptime'";
	await approval(harness, { text });
	const card = json(harness.fake.sent[0]);
	expect(card).toContain(messages().cardCopyLabel);
	expect(card).toContain(":copy");
	expect(card).not.toContain(text);
	// The copy button is never disabled: only run and cancel are, once the card ends.
	const disabled = JSON.stringify(
		harness.fake.sent[0]?.components.map((c) => c.toJSON()),
	).match(/"disabled":true/g);
	expect(disabled).toBeNull();
});

test("a label of its own names the button; without a copy text there is none", async () => {
	const withLabel = setup();
	await approval(withLabel, { label: "Copy the command", text: "ls" });
	expect(json(withLabel.fake.sent[0])).toContain("Copy the command");
	const without = setup();
	await approval(without);
	expect(json(without.fake.sent[0])).not.toContain(":copy");
	const empty = setup();
	await approval(empty, { text: "" });
	expect(json(empty.fake.sent[0])).not.toContain(":copy");
});

test("someone who may not approve copies the text, ephemerally and as often as they like, and the prompt stays unanswered", async () => {
	const harness = setup();
	const { answer, id } = await approval(harness, { text: "echo hello" });
	let settled = false;
	void answer.then(() => {
		settled = true;
	});
	for (let i = 0; i < 3; i++) {
		const copy = press("button", `${CARD_PREFIX}${id}:copy`, {
			user: STRANGER,
		});
		expect(await harness.cards.handle(copy.interaction)).toBe(true);
		expect(copy.replies).toEqual(["```\necho hello\n```"]);
		expect(copy.replied[0]?.flags).toBe(MessageFlags.Ephemeral);
		expect(copy.updates).toEqual([]);
	}
	await tick();
	expect(settled).toBe(false);
	// The stranger still cannot answer, and the owner still can.
	const refused = press("button", `${CARD_PREFIX}${id}:yes`, {
		user: STRANGER,
	});
	await harness.cards.handle(refused.interaction);
	expect(refused.replies).toHaveLength(1);
	expect(settled).toBe(false);
	await harness.cards.handle(
		press("button", `${CARD_PREFIX}${id}:yes`).interaction,
	);
	expect(await answer).toBe("approved");
});

test("the button keeps working once the card has ended", async () => {
	const harness = setup();
	const { answer, id } = await approval(harness, { text: "echo hello" });
	await harness.cards.handle(
		press("button", `${CARD_PREFIX}${id}:no`).interaction,
	);
	expect(await answer).toBe("declined");
	const copy = press("button", `${CARD_PREFIX}${id}:copy`, { user: STRANGER });
	await harness.cards.handle(copy.interaction);
	expect(copy.replies).toEqual(["```\necho hello\n```"]);
});

test("a text that does not fit a message, or holds a code fence, comes as a file", async () => {
	const harness = setup();
	const long = await approval(harness, { text: "x".repeat(3_000) });
	const fenced = await approval(harness, { text: "a ``` b" });
	for (const { id } of [long, fenced]) {
		const copy = press("button", `${CARD_PREFIX}${id}:copy`);
		await harness.cards.handle(copy.interaction);
		expect(copy.replies).toEqual([messages().cardCopyFile]);
		expect(copy.replied[0]?.files).toHaveLength(1);
		expect(copy.replied[0]?.flags).toBe(MessageFlags.Ephemeral);
	}
});

test("a text over the limit gets no button", async () => {
	const harness = setup();
	await approval(harness, { text: "x".repeat(COPY_TEXT_LIMIT + 1) });
	expect(json(harness.fake.sent[0])).not.toContain(":copy");
});

test("a card the process never kept says so, and answers nothing", async () => {
	const harness = setup();
	const copy = press("button", `${CARD_PREFIX}no-such-card:copy`);
	expect(await harness.cards.handle(copy.interaction)).toBe(true);
	expect(copy.replies).toEqual([messages().cardCopyGone]);
});

test("with a ledger the text survives a restart; without one it does not", async () => {
	const dir = mkdtempSync(join(tmpdir(), "card-copies-"));
	try {
		const copyLedgerPath = join(dir, "card-copies.json");
		const first = setup({ copyLedgerPath });
		const { id } = await approval(first, { text: "echo hello" });
		const restarted = setup({ copyLedgerPath });
		const copy = press("button", `${CARD_PREFIX}${id}:copy`, {
			user: STRANGER,
		});
		await restarted.cards.handle(copy.interaction);
		expect(copy.replies).toEqual(["```\necho hello\n```"]);
		const forgetful = setup();
		const gone = press("button", `${CARD_PREFIX}${id}:copy`);
		await forgetful.cards.handle(gone.interaction);
		expect(gone.replies).toEqual([messages().cardCopyGone]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
