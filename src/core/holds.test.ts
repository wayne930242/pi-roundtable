import { describe, expect, test } from "bun:test";
import type { ToolTurn } from "./define.ts";
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

describe("holdChain in a turn", () => {
	const turn = {} as ToolTurn;
	const later = (name: string, said: string | undefined): HoldRule => ({
		name,
		describe: () => "sync view",
		describeInTurn: async () => said,
	});

	test("answers at once when every rule asked does, as the plain check does", () => {
		const holds = holdChain([
			rule("a", "y", "a says y"),
			rule("b", "x", "b says x"),
		]);
		expect(holds.inTurn?.("x", {}, {}, turn)).toBe("b says x");
		expect(holds.inTurn?.("z", {}, {}, turn)).toBeUndefined();
	});

	test("asks a rule's describeInTurn instead of its describe", async () => {
		const holds = holdChain([later("a", "looked up")]);
		expect(await holds.inTurn?.("x", {}, {}, turn)).toBe("looked up");
		expect(holds("x", {}, {})).toBe("sync view");
	});

	test("goes on to the next rule when a rule that answers later has no opinion", async () => {
		const holds = holdChain([
			later("a", undefined),
			rule("b", "x", "b says x"),
		]);
		expect(await holds.inTurn?.("x", {}, {}, turn)).toBe("b says x");
	});

	test("a rule earlier in the chain wins before a later one is asked", async () => {
		let asked = false;
		const holds = holdChain([
			later("a", "a looked up"),
			{
				name: "b",
				describe: () => undefined,
				describeInTurn: () => {
					asked = true;
					return "b";
				},
			},
		]);
		expect(await holds.inTurn?.("x", {}, {}, turn)).toBe("a looked up");
		expect(asked).toBe(false);
	});

	test("hands the turn to the rule", async () => {
		const seen: ToolTurn[] = [];
		const holds = holdChain([
			{
				name: "spy",
				describe: () => undefined,
				describeInTurn: (_tool, _input, _context, given) => {
					seen.push(given);
					return undefined;
				},
			},
		]);
		await holds.inTurn?.("x", {}, {}, turn);
		expect(seen).toEqual([turn]);
	});

	test("a rejection rejects", async () => {
		const holds = holdChain([
			{
				name: "a",
				describe: () => undefined,
				describeInTurn: async () => {
					throw new Error("down");
				},
			},
		]);
		await expect(holds.inTurn?.("x", {}, {}, turn)).rejects.toThrow("down");
	});
});
