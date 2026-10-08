import { describe, expect, test } from "bun:test";
import type { ContextWithSystemEvent } from "@earendil-works/pi-coding-agent";
import {
	HIDDEN_MEMORY,
	HIDDEN_UNRECORDED_MEMORY,
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
