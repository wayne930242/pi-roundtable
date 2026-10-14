import { beforeAll, describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { holdChain } from "../../holds.ts";
import { messages } from "../../i18n/index.ts";
import type { Approval, Prompts } from "../../interactions/prompts.ts";
import { useTestLocale } from "../../testing/locale.ts";
import { TEST_OWNER as OWNER } from "../../testing/owner.ts";
import { promptSlot } from "../prompt-slot.ts";
import { approvalCard } from "./approval-card.ts";
import { MAIL, MAIL_RULE } from "./confirmation-fixture.ts";
import {
	ConfirmationGate,
	canonicalJson,
	confirmationGateExtension,
} from "./confirmation-gate.ts";

useTestLocale();
beforeAll(() => useTestLocale());

/** A tool's parameters the way Typebox writes them: properties in the order the tool declares them. */
const ISSUE = {
	type: "object",
	properties: {
		title: { type: "string", title: "Subject" },
		team: { type: "string" },
		priority: { type: "string", enum: ["urgent", "high", "low"] },
		notify: { type: "boolean" },
		estimate: { type: "number" },
		labels: { type: "array", items: { type: "string" } },
		description: { type: "string", title: "Details" },
		links: { type: "array", items: { type: "object" } },
		parent: { type: "string" },
	},
};

const call = (input: Record<string, unknown>) => ({
	tool: "issue_create",
	input: canonicalJson(input),
	action: "create an issue",
});

describe("an approval card given its tool's parameters", () => {
	test("lists the arguments as fields in the schema's order, labelled by title or name", () => {
		const card = approvalCard(
			call({
				team: "DEV",
				title: "Fix it",
				priority: "urgent",
				parent: "PM-973",
			}),
			undefined,
			{},
			ISSUE,
		);
		expect(card).toBe(
			[
				"**create an issue**",
				"-# `issue_create`",
				"**Subject**: Fix it",
				"**team**: DEV",
				"**priority**: urgent",
				"**parent**: PM\\-973".replace("\\-", "-"),
			].join("\n"),
		);
		expect(card).not.toContain("```json");
	});

	test("shows booleans, numbers and arrays of scalars on one line, and leaves absent fields out", () => {
		const card = approvalCard(
			call({ notify: false, estimate: 3, labels: ["a", "b", 2] }),
			undefined,
			{},
			ISSUE,
		);
		expect(card).toContain(
			"**notify**: false\n**estimate**: 3\n**labels**: a, b, 2",
		);
		expect(card).not.toContain("Subject");
		expect(card).not.toContain("team");
	});

	test("puts a multi-line string in a block that keeps its line breaks", () => {
		const description = "## Need\nOne\n\n- two\n```js\nx\n```";
		const card = approvalCard(call({ description }), undefined, {}, ISSUE);
		expect(card).toContain("**Details**:\n```\n## Need\nOne\n\n- two\n");
		// The text's own fence cannot close the block early.
		expect(card).not.toContain("\n```js");
		expect(card.endsWith("\n```")).toBe(true);
		// One block: it opens and closes once.
		expect(card.split("\n```").length).toBe(3);
	});

	test("puts a long one-line string in a block too", () => {
		const card = approvalCard(
			call({ description: "word ".repeat(40).trim() }),
			undefined,
			{},
			ISSUE,
		);
		expect(card).toContain("**Details**:\n```\nword word");
	});

	test("falls back to compact JSON for a nested value only", () => {
		const card = approvalCard(
			call({ title: "t", links: [{ a: 1 }, { b: [2] }] }),
			undefined,
			{},
			ISSUE,
		);
		expect(card).toContain("**Subject**: t");
		expect(card).toContain('**links**: `[{"a":1},{"b":[2]}]`');
	});

	test("a long nested value goes in a json block", () => {
		const card = approvalCard(
			call({ links: [{ url: "u".repeat(150) }] }),
			undefined,
			{ totalChars: 5_000, valueChars: 5_000 },
			ISSUE,
		);
		expect(card).toContain("**links**:\n```json\n[{");
	});

	test("shows an argument the schema does not list, after the listed ones", () => {
		const card = approvalCard(
			call({ zeta: "z", title: "t" }),
			undefined,
			{},
			ISSUE,
		);
		expect(card).toContain("**Subject**: t\n**zeta**: z");
	});

	test("cuts long strings the longest first, marks them, and keeps later fields", () => {
		const card = approvalCard(
			call({ description: "x".repeat(5_000), parent: "PM-1", title: "t" }),
			undefined,
			{},
			ISSUE,
		);
		expect(card).toContain("… [5000 chars]");
		expect(card).toContain("**parent**: PM-1");
		expect(card.length).toBeLessThan(1_700);
	});

	test("drops the last fields when the cut is not enough, and names them", () => {
		const input: Record<string, unknown> = {};
		const properties: Record<string, unknown> = {};
		for (let i = 0; i < 12; i++) {
			input[`field_${i}`] = "p".repeat(300);
			properties[`field_${i}`] = { type: "string" };
		}
		const card = approvalCard(
			call(input),
			undefined,
			{},
			{ type: "object", properties },
		);
		expect(card).toContain("**field\\_0**:");
		expect(card).toContain("… [300 chars]");
		expect(card).toContain(
			messages().cardHiddenKeys(
				[6, 7, 8, 9, 10, 11].map((i) => `field\\_${i}`),
			),
		);
		expect(card.length).toBeLessThan(1_800);
	});

	test("keeps the first field however small the limit is", () => {
		const card = approvalCard(
			call({ title: "t".repeat(400), team: "DEV" }),
			undefined,
			{ totalChars: 10, valueChars: 50 },
			ISSUE,
		);
		expect(card).toContain(
			`**Subject**:\n\`\`\`\n${"t".repeat(50)}… [400 chars]\n\`\`\``,
		);
		expect(card).toContain(messages().cardHiddenKeys(["team"]));
	});

	test("escapes markdown, links and mentions in a line, and in a label", () => {
		const card = approvalCard(
			call({
				title:
					"@everyone <@123> [click](https://evil.test) **bold** `code` ||x|| ~~s~~ _i_",
				team: "<@&99>",
			}),
			undefined,
			{},
			{
				type: "object",
				properties: {
					title: { type: "string", title: "*Sub* [ject](http://x.test) @here" },
					team: { type: "string" },
				},
			},
		);
		const body = card.split("\n").slice(2).join("\n");
		expect(body).not.toContain("@everyone");
		expect(body).not.toContain("@here");
		expect(body).toContain("@\u200beveryone");
		expect(body).toContain("\\<@123\\>");
		expect(body).toContain("\\[click\\](https://evil.test)");
		expect(body).toContain("\\*\\*bold\\*\\*");
		expect(body).toContain("\\`code\\`");
		expect(body).toContain("\\|\\|x\\|\\|");
		expect(body).toContain("\\~\\~s\\~\\~");
		expect(body).toContain("\\_i\\_");
		expect(body).toContain(
			"**\\*Sub\\* \\[ject\\](http://x.test) @\u200bhere**",
		);
		expect(body).toContain("**team**: \\<@&99\\>");
	});

	test("leaves an address as written", () => {
		const card = approvalCard(
			call({ title: "dana@example.test" }),
			undefined,
			{},
			ISSUE,
		);
		expect(card).toContain("**Subject**: dana@example.test");
	});

	test("a string with a line break cannot start markdown of its own, and mentions in a block stay inert text", () => {
		const card = approvalCard(
			call({ description: "# big\n@everyone\n> quote" }),
			undefined,
			{},
			ISSUE,
		);
		expect(card).toContain("```\n# big\n@everyone\n> quote\n```");
	});

	test("still lists the files a call sends", () => {
		const card = approvalCard(
			{
				tool: "send",
				input: canonicalJson({ files: [{ path: "gone.png" }], note: "n" }),
				action: "send",
			},
			"/nonexistent-root",
			{},
			{
				type: "object",
				properties: { note: { type: "string" }, files: { type: "array" } },
			},
		);
		expect(card).toContain("**note**: n");
		expect(card).toContain("File `gone.png` (not found now)");
	});

	test("without a usable schema the card is the JSON it was", () => {
		const held = call({ title: "t", team: "DEV" });
		const json = `\`\`\`json\n${held.input}\n\`\`\``;
		expect(approvalCard(held)).toContain(json);
		expect(approvalCard(held, undefined, {}, undefined)).toContain(json);
		expect(approvalCard(held, undefined, {}, { type: "object" })).toContain(
			json,
		);
		expect(approvalCard(held, undefined, {}, "nope")).toContain(json);
		expect(approvalCard(call({}), undefined, {}, ISSUE)).toContain(
			"```json\n{}\n```",
		);
	});
});

describe("the confirmation gate's extension", () => {
	const holds = holdChain([MAIL_RULE]);

	/** Runs one held call through the extension and returns the card text the owner was shown. */
	async function cardFor(
		tools: { name: string; parameters: unknown }[] | undefined,
	) {
		const gate = new ConfirmationGate(holds, OWNER);
		gate.beginTurn("workspace", false);
		const slot = promptSlot();
		const messagesShown: string[] = [];
		const prompts: Prompts = {
			confirm: async (_title, message) => {
				messagesShown.push(message);
				return "approved" satisfies Approval;
			},
			ask: async () => undefined,
		};
		slot.bind(prompts, "helper");
		type Handler = (
			event: { toolName: string; toolCallId: string; input: unknown },
			ctx: { signal?: AbortSignal },
		) => Promise<unknown>;
		let call: Handler | undefined;
		confirmationGateExtension(
			gate,
			slot,
		)({
			on: (event: string, h: Handler) => {
				if (event === "tool_call") call = h;
			},
			...(tools ? { getAllTools: () => tools } : {}),
		} as unknown as ExtensionAPI);
		await call?.(
			{
				toolName: MAIL,
				toolCallId: "c1",
				input: { subject: "hi", to: "a@b.c" },
			},
			{ signal: new AbortController().signal },
		);
		return messagesShown[0] ?? "";
	}

	test("shows a held call as the fields of the tool's own parameters", async () => {
		const card = await cardFor([
			{
				name: MAIL,
				parameters: {
					type: "object",
					properties: {
						to: { type: "string", title: "Recipient" },
						subject: { type: "string" },
					},
				},
			},
		]);
		expect(card).toContain("**Recipient**: a@b.c\n**subject**: hi");
	});

	test("shows JSON when the host lists no such tool, or no tools", async () => {
		expect(await cardFor([{ name: "other", parameters: {} }])).toContain(
			"```json",
		);
		expect(await cardFor(undefined)).toContain("```json");
	});
});
