import { expect, test } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MessageFlags } from "discord.js";
import { messages } from "../i18n/index.ts";
import { silentLogger } from "../log.ts";
import { CardCopies, COPY_TEXT_LIMIT } from "./card-copies.ts";
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
		const copies = { path: join(dir, "card-copies.json") };
		const first = setup({ copies });
		const { id } = await approval(first, { text: "echo hello" });
		await first.cards.flushCopies();
		const restarted = setup({ copies });
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

test("a blank label falls back to the default, a padded one is trimmed, a long one is cut to the button's limit; the card is posted in every case", async () => {
	const label = async (copy: string | undefined) => {
		const harness = setup();
		await approval(harness, {
			...(copy === undefined ? {} : { label: copy }),
			text: "echo hello",
		});
		const sent = JSON.parse(json(harness.fake.sent[0])) as unknown;
		const labels: string[] = [];
		const visit = (node: unknown): void => {
			if (Array.isArray(node)) node.forEach(visit);
			else if (node && typeof node === "object") {
				const object = node as Record<string, unknown>;
				if (String(object.custom_id).endsWith(":copy"))
					labels.push(String(object.label));
				Object.values(object).forEach(visit);
			}
		};
		visit(sent);
		return labels;
	};
	expect(await label("")).toEqual([messages().cardCopyLabel]);
	expect(await label("   ")).toEqual([messages().cardCopyLabel]);
	expect(await label(undefined)).toEqual([messages().cardCopyLabel]);
	expect(await label("  Copy it  ")).toEqual(["Copy it"]);
	expect(await label("x".repeat(200))).toEqual(["x".repeat(80)]);
});

test("a text of exactly the limit has a button; one character more has none and a warning is logged", async () => {
	const warnings: unknown[] = [];
	const logger = {
		...silentLogger(),
		warn: (...args: unknown[]) => warnings.push(args),
	};
	const harness = setup({ logger: logger as never });
	await approval(harness, { text: "x".repeat(COPY_TEXT_LIMIT) });
	expect(json(harness.fake.sent[0])).toContain(":copy");
	expect(warnings).toEqual([]);
	await approval(harness, { text: "x".repeat(COPY_TEXT_LIMIT + 1) });
	expect(json(harness.fake.sent[1])).not.toContain(":copy");
	expect(warnings).toHaveLength(1);
	expect(COPY_TEXT_LIMIT).toBe(20_000);
});

test("without a path the texts live in memory: the button works until a restart, which says the text is gone", async () => {
	const dir = mkdtempSync(join(tmpdir(), "card-copies-"));
	try {
		const first = setup({ copies: {} });
		const { id } = await approval(first, { text: "echo hello" });
		await first.cards.flushCopies();
		const same = press("button", `${CARD_PREFIX}${id}:copy`);
		await first.cards.handle(same.interaction);
		expect(same.replies).toEqual(["```\necho hello\n```"]);
		const restarted = setup({ copies: {} });
		const gone = press("button", `${CARD_PREFIX}${id}:copy`);
		await restarted.cards.handle(gone.interaction);
		expect(gone.replies).toEqual([messages().cardCopyGone]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the file holds the newest `keep` texts whole, for the host's user only, with no temporary file left behind", async () => {
	const dir = mkdtempSync(join(tmpdir(), "card-copies-"));
	try {
		const path = join(dir, "nested", "card-copies.json");
		const harness = setup({ copies: { path, keep: 2 } });
		for (const text of ["one", "two", "three"])
			await approval(harness, { text });
		await harness.cards.flushCopies();
		const stored = JSON.parse(readFileSync(path, "utf8")) as Record<
			string,
			{ text: string }
		>;
		expect(Object.values(stored).map((entry) => entry.text)).toEqual([
			"two",
			"three",
		]);
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(existsSync(`${path}.tmp`)).toBe(false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a text older than keepDays is gone, also from the file on the next start", async () => {
	const dir = mkdtempSync(join(tmpdir(), "card-copies-"));
	try {
		const path = join(dir, "card-copies.json");
		const day = 24 * 60 * 60_000;
		let now = 1_000_000;
		const first = new CardCopies({
			path,
			keepDays: 2,
			logger: silentLogger(),
			now: () => now,
		});
		first.remember("a", "old");
		await first.flush();
		now += day;
		expect(first.recall("a")).toBe("old");
		now += 2 * day;
		expect(first.recall("a")).toBeUndefined();
		const restarted = new CardCopies({
			path,
			keepDays: 2,
			logger: silentLogger(),
			now: () => now,
		});
		expect(restarted.recall("a")).toBeUndefined();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("remembering a text writes nothing before it returns; a burst is saved by the latest state, one write at a time", async () => {
	const dir = mkdtempSync(join(tmpdir(), "card-copies-"));
	try {
		const path = join(dir, "card-copies.json");
		const copies = new CardCopies({ path, logger: silentLogger() });
		for (const id of ["a", "b", "c"]) copies.remember(id, `text ${id}`);
		expect(existsSync(path)).toBe(false);
		await copies.flush();
		expect(Object.keys(JSON.parse(readFileSync(path, "utf8")))).toEqual([
			"a",
			"b",
			"c",
		]);
		copies.remember("d", "text d");
		await copies.flush();
		expect(Object.keys(JSON.parse(readFileSync(path, "utf8")))).toEqual([
			"a",
			"b",
			"c",
			"d",
		]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
