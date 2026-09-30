import { expect, test } from "bun:test";
import { testPlugin } from "pi-roundtable/testing";
import { cleanup } from "./holds.ts";

test("a tool's hold and a hold rule each describe the call that must wait", async () => {
	const harness = await testPlugin(cleanup);
	const rules = harness.contribution.holdRules ?? [];
	const describe = (tool: string, input: Record<string, unknown>) =>
		rules.flatMap((rule) => rule.describe(tool, input, {}) ?? []);
	expect(describe("file_delete", { path: "a.txt" })).toEqual(["Delete a.txt"]);
	expect(describe("bash", { command: "restart production" })).toEqual([
		"bash touches production",
	]);
	expect(describe("bash", { command: "ls" })).toEqual([]);
	await harness.stop();
});
