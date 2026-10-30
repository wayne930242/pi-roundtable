import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { messages } from "../../i18n/index.ts";
import type {
	OwnerAnswer,
	OwnerQuestion,
	PromptWait,
} from "../../interactions/prompts.ts";
import { TEST_OWNER as OWNER } from "../../testing/owner.ts";
import { PromptSlot } from "../prompt-slot.ts";
import { ASK_USER_TOOL, askUserExtension } from "./ask-user.ts";

interface Tool {
	name: string;
	prepareArguments?: (args: unknown) => unknown;
	execute: (
		id: string,
		params: unknown,
		signal?: AbortSignal,
	) => Promise<{ content: { text: string }[] }>;
}

/** ask_user over a slot whose cards answer with `answer`, recording each question. */
function askUser(answer: OwnerAnswer | "pending" | undefined, bound = true) {
	const asked: { title: string; question: OwnerQuestion }[] = [];
	const waits: PromptWait[] = [];
	const slot = new PromptSlot();
	slot.bind(
		bound
			? {
					confirm: async () => "expired",
					ask: async (title, question, _signal, wait) => {
						asked.push({ title, question });
						if (wait) waits.push(wait);
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
		waits,
		call: async (params: unknown) =>
			(await t.execute("call-1", t.prepareArguments?.(params) ?? params))
				.content[0]?.text ?? "",
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

	test("no answer says so", async () => {
		const { call } = askUser(undefined);
		expect(await call({ question: "?" })).toStartWith("No answer");
	});

	test("a question still open tells the model to end its turn waiting, and its late answer carries the question", async () => {
		const { waits, call } = askUser("pending");
		const text = await call({ question: "Which day?" });
		expect(text).toContain("Riley has not answered yet");
		expect(text).toContain("do not ask again");
		expect(text).toContain("End your turn now");
		const late = waits[0]?.late({
			kind: "question",
			answer: { choices: ["Sunday"], text: "after lunch" },
			by: "Riley",
		});
		expect(late).toContain("Question: Which day?");
		expect(late).toContain("Riley chose: Sunday");
		expect(late).toContain("Riley wrote: after lunch");
		expect(
			waits[0]?.late({ kind: "approval", approved: true, by: "Riley" }),
		).toBeUndefined();
	});

	test("a turn he did not start tells the model to ask in its reply", async () => {
		const { asked, call } = askUser({ choices: ["x"] }, false);
		expect(await call({ question: "?" })).toContain(
			"Write the question as your final answer instead",
		);
		expect(asked).toHaveLength(0);
	});
});

describe("ask_user, a single question keeps its 0.19 text", () => {
	test("the pending and late texts are exactly 0.19's", async () => {
		const { waits, call } = askUser("pending");
		expect(await call({ question: "Which day?" })).toBe(
			"Riley has not answered yet. The card stays open, so do not ask again and do not wait for it. End your turn now: say briefly that you are waiting for his answer on the card. When he answers, a new turn brings you the answer and you continue from there.",
		);
		expect(
			waits[0]?.late({
				kind: "question",
				answer: { choices: ["Sunday"], text: "after lunch" },
				by: "Ada",
			}),
		).toBe(
			"(Ada answered your earlier ask_user question on its card, after your turn had ended. Continue from where you stopped, with this answer.)\nQuestion: Which day?\nAda chose: Sunday\nAda wrote: after lunch",
		);
	});

	test("the questions form with one question asks the same card, headers dropped", async () => {
		const legacy = askUser({ choices: ["Sunday"] });
		const modern = askUser({ choices: ["Sunday"] });
		const options = [{ label: "Saturday" }, { label: "Sunday" }];
		const a = await legacy.call({
			question: "Which day?",
			options,
			allow_other: true,
		});
		const b = await modern.call({
			questions: [{ question: "Which day?", header: "Day", options }],
		});
		expect(b).toBe(a);
		expect(modern.asked).toEqual(legacy.asked);
	});
});

describe("ask_user, the questions form", () => {
	test("allow_other defaults to true in the questions form and to false in the legacy form", async () => {
		const modern = askUser({ choices: ["a"] });
		await modern.call({
			questions: [{ question: "?", options: [{ label: "a" }] }],
		});
		expect(modern.asked[0]?.question.allowOther).toBe(true);
		const closed = askUser({ choices: ["a"] });
		await closed.call({
			questions: [
				{ question: "?", options: [{ label: "a" }], allow_other: false },
			],
		});
		expect(closed.asked[0]?.question.allowOther).toBe(false);
		const legacy = askUser({ choices: ["a"] });
		await legacy.call({ question: "?", options: [{ label: "a" }] });
		expect(legacy.asked[0]?.question.allowOther).toBe(false);
	});

	test("double-encoded questions and options are decoded", async () => {
		const { asked, call } = askUser({ choices: ["a"] });
		await call({
			questions: JSON.stringify([
				{ question: "?", options: JSON.stringify([{ label: "a" }]) },
			]),
		});
		expect(asked[0]?.question.options).toEqual([{ label: "a" }]);
		await call({ question: "?", options: JSON.stringify([{ label: "b" }]) });
		expect(asked[1]?.question.options).toEqual([{ label: "b" }]);
	});

	test("a refused set posts no card and says why", async () => {
		const { asked, call } = askUser({ choices: ["a"] });
		const text = await call({
			questions: [{ question: "?", options: [{ label: "a" }, { label: "a" }] }],
		});
		expect(text).toContain("offered twice");
		expect(asked).toHaveLength(0);
	});

	test("a v1 surface is asked one question at a time, previews folded and headers dropped", async () => {
		const { asked, call } = askUser({ choices: ["a"] });
		const text = await call({
			questions: [
				{
					question: "First?",
					header: "One",
					options: [{ label: "a", preview: "mock" }],
				},
				{ question: "Second?", header: "Two", options: [{ label: "a" }] },
			],
		});
		expect(asked.map((a) => a.question.question)).toEqual([
			"First?\n\n**a**\n```\nmock\n```",
			"Second?",
		]);
		expect(asked[0]?.question).not.toHaveProperty("header");
		expect(text).toBe(
			"Riley answered your questions on the card:\n1. One: chose a\n2. Two: chose a",
		);
	});
});

describe("ask_user, review fixes", () => {
	const noCards =
		"Riley cannot answer buttons in this turn: no one wrote to you, a schedule or another agent started it, so nothing waits. Do not call ask_user again. Write the question as your final answer instead; it is posted to this channel for him to read, and his answer comes in a new turn.";
	test("no prompts: the turn is unattended, so it refuses at once, in both forms", async () => {
		const { call } = askUser({ choices: ["x"] }, false);
		expect(await call({ question: "?" })).toBe(noCards);
		expect(await call({ questions: [{ question: "?" }] })).toBe(noCards);
	});
	test("a non-boolean allow_other reaches the schema instead of becoming false", async () => {
		const { tool } = (() => {
			let tool: Tool | undefined;
			askUserExtension(
				new PromptSlot(),
				OWNER,
			)({
				registerTool: (t: Tool) => {
					tool = t;
				},
			} as unknown as ExtensionAPI);
			return { tool };
		})();
		const folded = tool?.prepareArguments?.({
			question: "?",
			allow_other: "true",
		});
		expect(folded).toMatchObject({ questions: [{ allow_other: "true" }] });
	});
	test("a double-encoded element is decoded; both forms at once is an error", async () => {
		const { asked, call } = askUser({ choices: [], text: "x" });
		await call({ questions: ['{"question":"b"}'] });
		expect(asked[0]?.question.question).toBe("b");
		await expect(
			call({ question: "a", questions: [{ question: "b" }] }),
		).rejects.toThrow("not both");
	});
	test("the sequential fallback names the question it stopped at", async () => {
		const { call } = askUser(undefined);
		const text = await call({
			questions: [{ question: "First?" }, { question: "Second?" }],
		});
		expect(text).toStartWith("1. First?: No answer");
	});
});
