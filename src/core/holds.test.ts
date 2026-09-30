import { describe, expect, test } from "bun:test";
import { PluginError } from "./errors.ts";
import { type HoldRule, holdChain } from "./holds.ts";

/** A rule that holds every call to `tool`, saying `said`. */
const rule = (name: string, tool: string, said: string): HoldRule => ({
	name,
	describe: (called) => (called === tool ? said : undefined),
});

describe("holdChain", () => {
	test("lets a call run when no rule holds it", () => {
		const holds = holdChain([rule("a", "x", "do x")]);
		expect(holds("y", {}, {})).toBeUndefined();
		expect(holdChain([])("x", {}, {})).toBeUndefined();
	});

	test("the first rule that describes a call holds it", () => {
		const holds = holdChain([
			rule("first", "x", "first says x"),
			rule("second", "x", "second says x"),
			rule("third", "y", "third says y"),
		]);
		expect(holds("x", {}, {})).toBe("first says x");
		expect(holds("y", {}, {})).toBe("third says y");
	});

	test("hands each rule the call's input and the session's workspace", () => {
		const seen: unknown[] = [];
		const holds = holdChain([
			{
				name: "spy",
				describe: (tool, input, context) => {
					seen.push({ tool, input, context });
					return undefined;
				},
			},
		]);
		holds("bash", { command: "ls" }, { workspace: "/work" });
		expect(seen).toEqual([
			{
				tool: "bash",
				input: { command: "ls" },
				context: { workspace: "/work" },
			},
		]);
	});

	test("refuses two rules with one name", () => {
		expect(() =>
			holdChain([rule("same", "x", "a"), rule("same", "y", "b")]),
		).toThrow(PluginError);
	});
});
