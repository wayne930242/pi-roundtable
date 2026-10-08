import { describe, expect, test } from "bun:test";
import {
	type AssistantMessage,
	type Message,
	type Model,
	normalizeContext,
} from "@earendil-works/pi-ai";
import { convertMessages as googleRequest } from "@earendil-works/pi-ai/api/google-shared";
import { convertResponsesMessages as responsesRequest } from "@earendil-works/pi-ai/api/openai-responses-shared";
import type { ContextWithSystemEvent } from "@earendil-works/pi-coding-agent";
import {
	HIDDEN_MEMORY,
	HIDDEN_UNRECORDED_MEMORY,
	MemoryDraws,
	memoryProjection,
	summaryProjection,
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

describe("the calls of the memory exchanges a request hides", () => {
	const answer = (calls: { id: string; name: string; fact: string }[]) => ({
		role: "assistant" as const,
		content: calls.map(({ id, name, fact }) => ({
			type: "toolCall" as const,
			id,
			name,
			arguments: { fact },
		})),
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
		stopReason: "toolUse" as const,
		timestamp: 2,
	});
	const answered = (id: string, toolName: string, details: unknown) => ({
		...result(toolName, "Done.", details),
		toolCallId: id,
	});
	const history: Messages = [
		{ role: "user", content: "Hello.", timestamp: 1 },
		answer([
			{ id: "c1", name: "memory_add", fact: "Ann's doctor" },
			{ id: "c2", name: "read_attachment", fact: "a public file" },
			{ id: "c3", name: "memory_add", fact: "Ann's locker" },
		]),
		answered("c1", "memory_add", { privateTo: "ann" }),
		answered("c2", "read_attachment", {}),
		// c3 has no result: its turn stopped before the call ran.
		{ role: "user", content: "Hi.", timestamp: 3 },
	];

	test("read with placeholder arguments beside their hidden results, another tool's call as it was", () => {
		const text = textOf(
			memoryProjection(history, { shared: true, reader: "bo" }),
		);
		expect(text).not.toContain("Ann's doctor");
		expect(text).not.toContain("Ann's locker");
		expect(text).toContain(`{"hidden":"${HIDDEN_MEMORY}"}`);
		expect(text).toContain(`{"hidden":"${HIDDEN_UNRECORDED_MEMORY}"}`);
		expect(text).toContain("a public file");
		expect(text).toContain('"id":"c1"');
	});

	test("show to the exchange's person, and to no one in a summary", () => {
		const own = textOf(
			memoryProjection(history, { shared: true, reader: "ann" }),
		);
		expect(own).toContain("Ann's doctor");
		const summary = textOf(summaryProjection(history));
		expect(summary).not.toContain("Ann's doctor");
		expect(summary).not.toContain("Ann's locker");
		expect(summary).toContain("a public file");
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

describe("the reasoning a provider signs onto an earlier answer's text", () => {
	const USAGE = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	/** A model of the api, as its provider's converter reads it. */
	const model = <A extends string>(api: A, provider: string, id: string) =>
		({
			id,
			name: id,
			api,
			provider,
			baseUrl: "http://provider.invalid",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 100_000,
			maxTokens: 1_000,
		}) as Model<A>;
	/** Ann's answer of the model, its text signed as the provider signs it. */
	const signed = (
		on: Model<string>,
		textSignature: string,
	): AssistantMessage => ({
		role: "assistant",
		content: [{ type: "text", text: "Noted.", textSignature }],
		api: on.api,
		provider: on.provider,
		model: on.id,
		usage: USAGE,
		stopReason: "stop",
		timestamp: 2,
	});
	const history = (answer: AssistantMessage): Messages => [
		{ role: "user", content: "Hello.", timestamp: 1 },
		answer,
		{ role: "user", content: "Hi.", timestamp: 3 },
	];
	// SAFETY: this history holds only Pi's messages, no custom ones, as a converter reads them.
	const context = (messages: Messages) =>
		normalizeContext({ messages: messages as Message[] });
	// Google's signatures are base64 bytes; its converter sends no other.
	const SIGNED = Buffer.from("ANN_TEXT_SIGNED").toString("base64");
	const shared = (messages: Messages) =>
		memoryProjection(messages, { shared: true, reader: "bo" }) ?? messages;

	test("Gemini's thought signature on the text of an earlier turn reaches neither the next request nor a summary", () => {
		const gemini = model(
			"google-generative-ai",
			"google",
			"gemini-3-pro-preview",
		);
		const messages = history(signed(gemini, SIGNED));
		// The converter sends it back as the part's thoughtSignature while the history keeps it.
		expect(JSON.stringify(googleRequest(gemini, context(messages)))).toContain(
			SIGNED,
		);
		for (const sent of [shared(messages), summaryProjection(messages)]) {
			const request = JSON.stringify(googleRequest(gemini, context(sent)));
			expect(request).not.toContain(SIGNED);
			expect(request).toContain("Noted.");
		}
		for (const api of ["google-vertex", "pi-messages", "another-api"]) {
			const other = model(api, "elsewhere", "m-1");
			const text = JSON.stringify(shared(history(signed(other, SIGNED))));
			expect(text).not.toContain(SIGNED);
		}
	});

	test("OpenAI's signature of an answer's message, its phase, is no reasoning and stays", () => {
		for (const api of [
			"openai-responses",
			"azure-openai-responses",
			"openai-codex-responses",
		]) {
			const gpt = model(api, "openai", "gpt-6.1-sol");
			const messages = history(
				signed(
					gpt,
					JSON.stringify({ v: 1, id: "msg_ann", phase: "final_answer" }),
				),
			);
			for (const sent of [shared(messages), summaryProjection(messages)]) {
				const request = responsesRequest(
					gpt,
					context(sent),
					new Set(["openai"]),
				);
				expect(request).toContainEqual(
					expect.objectContaining({ type: "message", phase: "final_answer" }),
				);
			}
		}
	});
});
