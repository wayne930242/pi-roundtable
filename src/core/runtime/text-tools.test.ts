import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { AgentError, ScheduleError } from "../domain/errors.ts";
import {
	optionalString,
	requiredString,
	stringList,
	type TextToolDef,
	textToolsExtension,
} from "./text-tools.ts";

interface Registered {
	name: string;
	label: string;
	execute: (
		id: string,
		params: unknown,
		signal: AbortSignal | undefined,
	) => Promise<{
		isError?: boolean;
		content: { type: string; text: string }[];
		details?: unknown;
	}>;
}

async function registered(defs: TextToolDef[]): Promise<Registered[]> {
	const tools: Registered[] = [];
	await textToolsExtension(
		defs,
		AgentError,
	)({
		registerTool: (tool: Registered) => {
			tools.push(tool);
		},
	} as unknown as ExtensionAPI);
	return tools;
}

const def = (run: TextToolDef["run"]): TextToolDef => ({
	name: "echo",
	label: "Echo",
	description: "Echo.",
	parameters: Type.Object({}),
	run,
});

describe("textToolsExtension", () => {
	test("registers each tool and returns its text", async () => {
		const [tool] = await registered([def((i) => `got ${String(i.word)}`)]);
		expect(tool?.name).toBe("echo");
		expect(tool?.label).toBe("Echo");
		const result = await tool?.execute("1", { word: "hi" }, undefined);
		expect(result).toEqual({
			content: [{ type: "text", text: "got hi" }],
			details: {},
		});
	});

	test("passes the call's signal to the tool", async () => {
		const signal = new AbortController().signal;
		let seen: AbortSignal | undefined;
		const [tool] = await registered([
			def((_i, s) => {
				seen = s;
				return "ok";
			}),
		]);
		await tool?.execute("1", {}, signal);
		expect(seen).toBe(signal);
	});

	test("turns the refusal class into an error result", async () => {
		const [tool] = await registered([
			def(() => {
				throw new AgentError("no such agent");
			}),
		]);
		const result = await tool?.execute("1", {}, undefined);
		expect(result?.isError).toBe(true);
		expect(result?.content[0]?.text).toBe("no such agent");
	});

	test("lets any other error fail the call", async () => {
		const [tool] = await registered([
			def(() => {
				throw new ScheduleError("wrong domain");
			}),
		]);
		expect(tool?.execute("1", {}, undefined)).rejects.toThrow("wrong domain");
	});
});

describe("tool input", () => {
	test("reads strings and string lists", () => {
		const input = { a: "x", n: 3, list: ["p", 4, "q"] };
		expect(optionalString(input, "a")).toBe("x");
		expect(optionalString(input, "n")).toBeUndefined();
		expect(stringList(input, "list")).toEqual(["p", "q"]);
		expect(stringList(input, "a")).toBeUndefined();
	});

	test("refuses a blank required string with AgentError", () => {
		expect(requiredString({ a: " x " }, "a")).toBe(" x ");
		expect(() => requiredString({ a: "  " }, "a")).toThrow(
			new AgentError("a is required."),
		);
		expect(() => requiredString({}, "b")).toThrow(AgentError);
	});
});
