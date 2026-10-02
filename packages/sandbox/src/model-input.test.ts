import { expect, test } from "bun:test";
import { modelInput } from "./model-input.ts";

for (const message of [
	{
		role: "user",
		content: [
			{
				type: "image_url",
				image_url: { url: "https://guest.example/private" },
			},
		],
	},
	{
		role: "user",
		content: [{ type: "file", file: { file_id: "operator-file" } }],
	},
	{
		role: "user",
		content: [{ type: "input_audio", input_audio: { data: "audio" } }],
	},
	{ role: "user", content: "hello", file_id: "operator-file" },
	{ role: "developer", content: "hello" },
	{
		role: "assistant",
		content: "",
		tool_calls: [
			{
				type: "web_search",
				id: "one",
				function: { name: "search", arguments: "{}" },
			},
		],
	},
])
	test(`refuses non-text or provider-capability message ${JSON.stringify(message)}`, () =>
		expect(modelInput({ messages: [message] })).toBeUndefined());

for (const tool of [
	{ type: "web_search" },
	{ type: "file_search", file_ids: ["operator-file"] },
	{
		type: "function",
		function: {
			name: "example",
			description: "Example",
			parameters: { $ref: "https://guest.example/schema" },
		},
	},
])
	test(`refuses provider tool or remote schema ${JSON.stringify(tool)}`, () =>
		expect(modelInput({ messages: [], tools: [tool] })).toBeUndefined());

test("normalizes text/function transcripts and removes undeclared function fields", () => {
	const input = modelInput({
		messages: [
			{ role: "system", content: "Be useful" },
			{ role: "user", content: "Hello" },
			{
				role: "assistant",
				content: "",
				tool_calls: [
					{
						id: "one",
						type: "function",
						function: {
							name: "clock",
							arguments: "{}",
							url: "https://guest.example",
						},
					},
				],
			},
			{ role: "tool", content: "Today", tool_call_id: "one" },
		],
		tools: [
			{
				type: "function",
				function: {
					name: "clock",
					description: "Clock",
					parameters: { type: "object" },
					extra_provider_option: "ignored",
				},
			},
		],
	});
	expect(input).toBeDefined();
	expect(JSON.stringify(input)).not.toContain("guest.example");
	expect(JSON.stringify(input)).not.toContain("extra_provider_option");
	expect(JSON.stringify(input)).toContain("tool_call_id");
});
