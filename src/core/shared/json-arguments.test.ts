import { describe, expect, test } from "bun:test";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { decodedJson, decodeJsonArguments } from "./json-arguments.ts";

const NAMES = Type.Object({
	names: Type.Union([
		Type.Array(Type.String(), { minItems: 1 }),
		Type.Literal("finished"),
	]),
	note: Type.Optional(Type.String()),
	limits: Type.Optional(Type.Object({ count: Type.Number() })),
});

/** What the tool receives once pi has checked the prepared arguments, as it does for every call. */
const received = (args: unknown) =>
	validateToolArguments(
		{ name: "t", description: "", parameters: NAMES } as never,
		{
			type: "toolCall",
			id: "1",
			name: "t",
			arguments: decodeJsonArguments(NAMES, args),
		} as never,
	);

describe("decodeJsonArguments", () => {
	test("a list sent as JSON text reaches the tool as the list", () => {
		expect(received({ names: '["blog-2"]' })).toEqual({ names: ["blog-2"] });
		expect(received({ names: ' ["a", "b"]' })).toEqual({ names: ["a", "b"] });
	});

	test("an object sent as JSON text is decoded, its fields converted as pi would", () => {
		expect(received({ names: "finished", limits: '{"count": "3"}' })).toEqual({
			names: "finished",
			limits: { count: 3 },
		});
	});

	test("a word, a real list, and a string field stay as they are", () => {
		expect(received({ names: "finished" })).toEqual({ names: "finished" });
		expect(received({ names: ["x"] })).toEqual({ names: ["x"] });
		expect(received({ names: ["x"], note: '["kept as text"]' })).toEqual({
			names: ["x"],
			note: '["kept as text"]',
		});
	});

	test("text that is no JSON, or decodes to something refused, is left for the schema", () => {
		const bad = { names: "[not json" };
		expect(decodeJsonArguments(NAMES, bad)).toBe(bad);
		const empty = { names: "[]" };
		expect(decodeJsonArguments(NAMES, empty)).toBe(empty);
	});
});

describe("decodedJson", () => {
	test("parses JSON text and returns anything else unchanged", () => {
		expect(decodedJson('[{"a":1}]')).toEqual([{ a: 1 }]);
		expect(decodedJson("plain")).toBe("plain");
		expect(decodedJson(4)).toBe(4);
	});
});
