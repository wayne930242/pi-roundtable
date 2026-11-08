import { describe, expect, test } from "bun:test";
import type { VirtualServer } from "pi-roundtable/kit";
import { toolHintsHoldRule } from "./tool-hints.ts";

const server = (
	name: string,
	hints: VirtualServer["hints"],
	tools: string[] = Object.keys(hints ?? {}),
): VirtualServer => ({
	name,
	url: `http://cf/servers/${name}/mcp`,
	tools,
	hints,
});

/** ContextForge's hints for futures-trader's three kinds of tool, plus a tool that declares none. */
const twst = server(
	"twst",
	{
		"twst-read": { readOnlyHint: true, destructiveHint: false },
		"twst-destroy": { readOnlyHint: false, destructiveHint: true },
		"twst-derived": { readOnlyHint: false, destructiveHint: false },
		"twst-only-destructive": { destructiveHint: true },
		"twst-only-readonly-true": { readOnlyHint: true },
		"twst-only-additive": { destructiveHint: false },
		"twst-contradiction": { readOnlyHint: true, destructiveHint: true },
	},
	[
		"twst-read",
		"twst-destroy",
		"twst-derived",
		"twst-only-destructive",
		"twst-only-readonly-true",
		"twst-only-additive",
		"twst-contradiction",
		"twst-no-hints",
	],
);

const rule = (...servers: VirtualServer[]) =>
	toolHintsHoldRule({ servers: () => servers });

describe("toolHintsHoldRule", () => {
	test("holds a tool whose hints say destructive", () => {
		expect(rule(twst).describe("twst-destroy", {}, {})).toContain(
			"twst-destroy",
		);
		expect(rule(twst).describe("twst-only-destructive", {}, {})).toBeDefined();
	});

	test("holds a tool that says readOnlyHint false, destructive or not", () => {
		expect(rule(twst).describe("twst-derived", {}, {})).toContain(
			"twst-derived",
		);
	});

	test("holds a tool that says both read-only and destructive", () => {
		expect(rule(twst).describe("twst-contradiction", {}, {})).toBeDefined();
	});

	test("runs a read-only tool", () => {
		expect(rule(twst).describe("twst-read", {}, {})).toBeUndefined();
		expect(
			rule(twst).describe("twst-only-readonly-true", {}, {}),
		).toBeUndefined();
	});

	test("runs a tool that declares no hint to hold it", () => {
		expect(rule(twst).describe("twst-no-hints", {}, {})).toBeUndefined();
		expect(rule(twst).describe("twst-only-additive", {}, {})).toBeUndefined();
		expect(
			rule(server("bare", undefined, ["bare-x"])).describe("bare-x", {}, {}),
		).toBeUndefined();
		expect(
			rule(server("bare", {}, ["bare-x"])).describe("bare-x", {}, {}),
		).toBeUndefined();
	});

	test("runs a tool no server lists", () => {
		expect(rule(twst).describe("shell", {}, {})).toBeUndefined();
		expect(rule(twst).describe("twst-unknown", {}, {})).toBeUndefined();
	});

	test("holds a call with an empty input, as a precheck script's call arrives", () => {
		expect(rule(twst).describe("twst-destroy", {}, {})).toBeDefined();
	});

	test("holds a tool that any server listing it marks as held", () => {
		const loose = server("other", { "twst-destroy": { readOnlyHint: true } }, [
			"twst-destroy",
		]);
		expect(rule(loose, twst).describe("twst-destroy", {}, {})).toBeDefined();
		expect(rule(twst, loose).describe("twst-destroy", {}, {})).toBeDefined();
	});

	test("names the tool, server and kind of hint, and the call's input only", () => {
		const said = rule(twst).describe(
			"twst-destroy",
			{ kind: "live_order", id: "abc" },
			{},
		);
		expect(said).toContain("twst-destroy");
		expect(said).toContain("twst");
		expect(said).toContain("destructive");
		expect(rule(twst).describe("twst-derived", {}, {})).toContain(
			"not read-only",
		);
	});

	test("never lets yolo approve what it holds", () => {
		expect(rule(twst).yolo).toBe("never");
	});

	test("reads the servers afresh on every call", () => {
		let servers: VirtualServer[] = [];
		const live = toolHintsHoldRule({ servers: () => servers });
		expect(live.describe("twst-destroy", {}, {})).toBeUndefined();
		servers = [twst];
		expect(live.describe("twst-destroy", {}, {})).toBeDefined();
	});
});
