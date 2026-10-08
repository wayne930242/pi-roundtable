import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { messages } from "../../i18n/index.ts";
import type { OwnerAnswer, OwnerQuestion } from "../../interactions/prompts.ts";
import { TEST_OWNER as OWNER } from "../../testing/owner.ts";
import { PromptSlot } from "../prompt-slot.ts";
import { ASK_USER_TOOL, askUserExtension } from "./ask-user.ts";

interface Tool {
	name: string;
	execute: (
		id: string,
		params: unknown,
		signal?: AbortSignal,
	) => Promise<{ content: { text: string }[] }>;
}

/** ask_user over a slot whose cards answer with `answer`, recording each question. */
function askUser(answer: OwnerAnswer | undefined, bound = true) {
	const asked: { title: string; question: OwnerQuestion }[] = [];
	const slot = new PromptSlot();
	slot.bind(
		bound
			? {
					confirm: async () => "expired",
					ask: async (title, question) => {
						asked.push({ title, question });
						return answer;
					},
				}
			: undefined,
		"infra",
	);
	let tool: Tool | undefined;
	askUserExtension(
		slot,
		OWNER,
	)({
		registerTool: (t: Tool) => {
			tool = t;
		},
	} as unknown as ExtensionAPI);
	if (tool?.name !== ASK_USER_TOOL) throw new Error("ask_user not registered");
	const t = tool;
	return {
		asked,
		call: async (params: unknown) =>
			(await t.execute("call-1", params)).content[0]?.text ?? "",
	};
}

describe("ask_user", () => {
	test("a single choice comes back as the chosen label", async () => {
		const { asked, call } = askUser({ choices: ["Sunday"] });
		const text = await call({
			question: "Which day?",
			options: [
				{ label: "Saturday" },
				{ label: "Sunday", description: "afternoon" },
			],
		});
		expect(text).toBe("Riley chose: Sunday");
		expect(asked[0]).toEqual({
			title: messages().askTitle("infra"),
			question: {
				question: "Which day?",
				options: [
					{ label: "Saturday" },
					{ label: "Sunday", description: "afternoon" },
				],
				multi: false,
				allowOther: false,
			},
		});
	});

	test("several choices and the owner's own words", async () => {
		const { asked, call } = askUser({
			choices: ["Saturday", "Monday"],
			text: "Wednesday works too",
		});
		const text = await call({
			question: "Which days?",
			options: [{ label: "Saturday" }, { label: "Monday" }],
			multi: true,
			allow_other: true,
		});
		expect(text).toBe(
			"Riley chose: Saturday; Monday\nRiley wrote: Wednesday works too",
		);
		expect(asked[0]?.question).toMatchObject({ multi: true, allowOther: true });
	});

	test("a free-text question", async () => {
		const { asked, call } = askUser({ choices: [], text: "call me Nova" });
		expect(await call({ question: "What name?" })).toBe(
			"Riley wrote: call me Nova",
		);
		expect(asked[0]?.question.options).toEqual([]);
	});

	test("no answer in time says so", async () => {
		const { call } = askUser(undefined);
		expect(await call({ question: "?" })).toStartWith("No answer");
	});

	test("a turn he did not start tells the model to ask in its reply", async () => {
		const { asked, call } = askUser({ choices: ["x"] }, false);
		expect(await call({ question: "?" })).toContain(
			"Ask him in your reply instead",
		);
		expect(asked).toHaveLength(0);
	});
});
