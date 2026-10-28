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

describe("hold classes", () => {
	const inTurn = { toolTurn: undefined } as unknown as ToolTurn;

	test("a rule without classes leaves its call unclassed: its bare name", () => {
		const holds = holdChain([rule("mail", "send", "send mail")]);
		expect(holds.classesOf?.("send", {}, {})).toEqual(["mail"]);
		expect(holds.classesOf?.("other", {}, {})).toBeUndefined();
	});

	test("a rule's own classes replace its name, once each", () => {
		const holds = holdChain([
			{
				...rule("shell", "bash", "run it"),
				holdClasses: () => ["shell.rm", "shell.rm", "shell.write"],
			},
		]);
		expect(holds.classesOf?.("bash", {}, {})).toEqual([
			"shell.rm",
			"shell.write",
		]);
	});

	test("a rule whose classes are empty, absent or throw leaves its call unclassed", () => {
		for (const holdClasses of [
			() => [],
			() => undefined,
			() => {
				throw new Error("broken");
			},
		]) {
			const holds = holdChain([{ ...rule("r", "x", "x"), holdClasses }]);
			expect(holds.classesOf?.("x", {}, {})).toEqual(["r"]);
		}
	});

	test("a class id outside the rule's name leaves the whole call unclassed", () => {
		for (const ids of [
			["other.rm"],
			["shell.rm", "other.rm"],
			["shellrm"],
			["shell.rm", ""],
			["shell.rm", 3],
		]) {
			const holds = holdChain([
				{
					...rule("shell", "x", "x"),
					holdClasses: () => ids as unknown as string[],
				},
			]);
			expect([ids, holds.classesOf?.("x", {}, {})]).toEqual([ids, ["shell"]]);
		}
	});

	test("a rule may relay the classes of another rule of the chain", () => {
		const holds = holdChain([
			rule("a", "never", "n"),
			{
				...rule("relay", "x", "x"),
				relay: true,
				holdClasses: () => ["a.one", "a", "relay.two"],
			},
		]);
		expect(holds.classesOf?.("x", {}, {})).toEqual([
			"a.one",
			"a",
			"relay.two",
			"relay.relay",
		]);
	});

	test("a rule that is not a relay cannot report another rule's ids", () => {
		const holds = holdChain([
			rule("shell", "never", "n"),
			{ ...rule("mail", "x", "x"), holdClasses: () => ["shell.write"] },
		]);
		expect(holds.classesOf?.("x", {}, {})).toEqual(["mail"]);
	});

	test("a rule name with a dot is refused", () => {
		expect(() => holdChain([rule("a.b", "x", "x")])).toThrow("a.b");
	});

	test("the classes are those of every rule that holds the call", () => {
		const holds = holdChain([
			{ ...rule("a", "y", "a says y"), holdClasses: () => ["a.one"] },
			{ ...rule("b", "x", "b says x"), holdClasses: () => ["b.two"] },
			{ ...rule("c", "x", "c says x"), holdClasses: () => ["c.three"] },
			rule("d", "x", "d says x"),
		]);
		expect(holds.classesOf?.("x", {}, {})).toEqual(["b.two", "c.three", "d"]);
		expect(holds.inTurnWithClasses?.("x", {}, {}, inTurn)).toEqual({
			description: "b says x",
			classes: ["b.two", "c.three", "d"],
		});
	});

	test("in a turn a later rule's lookup counts too, and one that fails leaves its rule's name", async () => {
		const holds = holdChain([
			{ ...rule("a", "x", "a says x"), holdClasses: () => ["a.one"] },
			{
				name: "slow",
				describe: () => undefined,
				describeInTurn: async () => ({ text: "slow", classes: ["slow.x"] }),
			},
			{
				name: "broken",
				describe: () => undefined,
				describeInTurn: async () => {
					throw new Error("down");
				},
			},
			{
				name: "sync",
				describe: () => undefined,
				describeInTurn: () => {
					throw new Error("down");
				},
			},
		]);
		expect(await holds.inTurnWithClasses?.("x", {}, {}, inTurn)).toEqual({
			description: "a says x",
			classes: ["a.one", "slow.x", "broken", "sync"],
		});
	});

	test("in a turn the classes come with the description, and inTurn still answers the description alone", async () => {
		const holds = holdChain([
			{
				name: "lookup",
				describe: () => undefined,
				describeInTurn: async () => "looked up",
			},
		]);
		expect(await holds.inTurn?.("x", {}, {}, inTurn)).toBe("looked up");
		expect(await holds.inTurnWithClasses?.("x", {}, {}, inTurn)).toEqual({
			description: "looked up",
			classes: ["lookup"],
		});
	});

	test("classes a description names itself win over the rule's", () => {
		const holds = holdChain([
			{
				name: "repo",
				describe: () => undefined,
				describeInTurn: () => ({ text: "push", classes: ["repo.push"] }),
				holdClasses: () => ["repo.other"],
			},
		]);
		expect(holds.inTurnWithClasses?.("x", {}, {}, inTurn)).toEqual({
			description: { text: "push", classes: ["repo.push"] },
			classes: ["repo.push"],
		});
	});

	test("classes a description names outside its rule leave the call unclassed, whatever the rule says", () => {
		const holds = holdChain([
			{
				name: "repo",
				describe: () => undefined,
				describeInTurn: () => ({ text: "push", classes: ["push"] }),
				holdClasses: () => ["repo.safe"],
			},
		]);
		expect(holds.inTurnWithClasses?.("x", {}, {}, inTurn)).toMatchObject({
			classes: ["repo"],
		});
	});

	test("a call no rule holds has none", async () => {
		const holds = holdChain([rule("a", "x", "x")]);
		expect(holds.inTurnWithClasses?.("y", {}, {}, inTurn)).toBeUndefined();
		const later = holdChain([
			{
				name: "l",
				describe: () => undefined,
				describeInTurn: async () => undefined,
			},
		]);
		expect(
			await later.inTurnWithClasses?.("y", {}, {}, inTurn),
		).toBeUndefined();
	});

	test("a lookup that fails before any rule held the call still rejects", async () => {
		const holds = holdChain([
			{
				name: "l",
				describe: () => undefined,
				describeInTurn: async () => {
					throw new Error("down");
				},
			},
		]);
		await expect(
			holds.inTurnWithClasses?.("x", {}, {}, inTurn),
		).rejects.toThrow("down");
	});
});
