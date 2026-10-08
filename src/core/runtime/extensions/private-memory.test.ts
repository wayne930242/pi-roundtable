import { describe, expect, test } from "bun:test";
import type { ContextWithSystemEvent } from "@earendil-works/pi-coding-agent";
import {
	HIDDEN_MEMORY,
	HIDDEN_UNRECORDED_MEMORY,
	MemoryDraws,
	memoryProjection,
} from "./private-memory.ts";

type Messages = ContextWithSystemEvent["messages"];

const prompt = (memory: string, timestamp: number) => ({
	role: "system" as const,
	content: "",
	sections: { addendum: `<addendum>\n${memory}\n</addendum>` },
	timestamp,
});

let calls = 0;
const result = (
	toolName: string,
	text: string,
	details: unknown,
	isError = false,
) => ({
	role: "toolResult" as const,
	toolCallId: `call-${++calls}`,
	toolName,
	content: [{ type: "text" as const, text }],
	// SAFETY: a session's tool result details are whatever its tool returned, JSON by Pi's contract.
	details: details as never,
	isError,
	timestamp: 2,
});

const textOf = (messages: Messages | undefined) => JSON.stringify(messages);

describe("the memory a request may carry", () => {
	const history: Messages = [
		prompt("Ann's memory", 1),
		{ role: "user", content: "Hello.", timestamp: 2 },
		result("memory_search", "Ann's doctor", { privateTo: "ann" }),
		result("memory_search", "an old result", {}),
		result("memory_remove", 'No remembered fact contains "x".', {}, true),
		result("read_attachment", "a file", {}),
		prompt("Bo's memory", 3),
		{ role: "user", content: "Hi.", timestamp: 4 },
	];

	test("in a shared conversation, only the reader's results show, and the prompt is the current one alone", () => {
		const projected = memoryProjection(history, { shared: true, reader: "bo" });
		const text = textOf(projected);
		expect(text).not.toContain("Ann's doctor");
		expect(text).not.toContain("Ann's memory");
		expect(text).not.toContain("an old result");
		expect(text).toContain(HIDDEN_MEMORY);
		expect(text).toContain(HIDDEN_UNRECORDED_MEMORY);
		// An error says nothing of anyone's memory; another tool's result is not memory.
		expect(text).toContain("No remembered fact contains");
		expect(text).toContain("a file");
		expect(projected?.filter((m) => m.role === "system")).toHaveLength(1);
		expect(projected?.[0]?.role).toBe("system");
		expect(text).toContain("Bo's memory");
	});

	test("the result's person sees it; the host's own turn and a moment with no reader see no one's", () => {
		expect(
			textOf(memoryProjection(history, { shared: true, reader: "ann" })),
		).toContain("Ann's doctor");
		expect(
			textOf(memoryProjection(history, { shared: true, reader: undefined })),
		).not.toContain("Ann's doctor");
	});

	test("a private conversation keeps its prompt history and its person's results, even those recorded before results said whose", () => {
		const own: Messages = [
			prompt("Ann's memory", 1),
			result("memory_search", "Ann's doctor", { privateTo: "ann" }),
			result("memory_search", "an old result", {}),
			prompt("Ann's memory, later", 3),
		];
		expect(
			memoryProjection(own, { shared: false, reader: "ann" }),
		).toBeUndefined();
		// Someone else's result there still never shows.
		const theirs = memoryProjection(
			[...own, result("memory_search", "Bo's note", { privateTo: "bo" })],
			{ shared: false, reader: "ann" },
		);
		expect(textOf(theirs)).not.toContain("Bo's note");
		expect(theirs?.filter((m) => m.role === "system")).toHaveLength(2);
	});

	test("a shared conversation with one prompt and nothing private is sent as it is", () => {
		expect(
			memoryProjection(
				[
					prompt("Bo's memory", 1),
					{ role: "user", content: "Hi.", timestamp: 2 },
				],
				{ shared: true, reader: "bo" },
			),
		).toBeUndefined();
	});
});

describe("the tool calls that draw on the reader's memory", () => {
	test("every call running when something reads it draws on it, a call nested in another's too; a later one does not", () => {
		const draws = new MemoryDraws();
		draws.start("outer");
		draws.start("outer/1");
		draws.start("beside");
		expect(draws.end("beside")).toBe(false);
		draws.drawn();
		draws.start("later");
		expect(draws.end("outer/1")).toBe(true);
		expect(draws.end("outer")).toBe(true);
		expect(draws.end("later")).toBe(false);
		// An ended call is forgotten.
		expect(draws.end("outer")).toBe(false);
	});
});

describe("the reasoning a request may carry", () => {
	const answer = (thought: string, timestamp: number) => ({
		role: "assistant" as const,
		content: [
			{
				type: "thinking" as const,
				thinking: thought,
				thinkingSignature: `${thought} signed`,
			},
			{ type: "text" as const, text: "An answer." },
		],
		api: "faux",
		provider: "faux",
		model: "faux-1",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp,
	});
	const history: Messages = [
		{ role: "user", content: "Hello.", timestamp: 1 },
		answer("Ann's reasoning", 2),
		{ role: "user", content: "Hi.", timestamp: 3 },
		answer("Bo's reasoning", 4),
	];

	test("a shared conversation's earlier turns read without theirs, the running turn with its own", () => {
		const text = textOf(
			memoryProjection(history, { shared: true, reader: "bo" }),
		);
		expect(text).not.toContain("Ann's reasoning");
		expect(text).toContain("Bo's reasoning signed");
		expect(text.match(/An answer\./g)).toHaveLength(2);
	});

	test("a private conversation keeps every turn's", () => {
		expect(
			memoryProjection(history, { shared: false, reader: "ann" }),
		).toBeUndefined();
	});
});
