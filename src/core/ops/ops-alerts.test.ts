import { describe, expect, test } from "bun:test";
import type { Logger } from "../log.ts";
import { OpsAlerts, type OpsAlertsOptions } from "./ops-alerts.ts";

const HOUR = 3_600_000;

function setup(options: Partial<OpsAlertsOptions> = {}) {
	let now = 1_000_000;
	const posted: string[] = [];
	const warnings: { fields: unknown; msg: string }[] = [];
	const logger = {
		warn: (fields: unknown, msg: string) => warnings.push({ fields, msg }),
	} as unknown as Logger;
	let sink: OpsAlertsOptions["sink"] = async (text) => {
		posted.push(text);
		return true;
	};
	if ("sink" in options) sink = options.sink;
	const alerts = new OpsAlerts({
		logger,
		now: () => now,
		...options,
		sink,
	});
	return {
		alerts,
		posted,
		warnings,
		advance: (ms: number) => {
			now += ms;
		},
	};
}

describe("OpsAlerts", () => {
	test("posts a key once per window, then again", async () => {
		const { alerts, posted, advance } = setup();
		expect(await alerts.raise("push:a", "one")).toBe(true);
		expect(await alerts.raise("push:a", "two")).toBe(false);
		advance(HOUR - 1);
		expect(await alerts.raise("push:a", "three")).toBe(false);
		advance(1);
		expect(await alerts.raise("push:a", "four")).toBe(true);
		expect(posted).toEqual(["one", "four"]);
	});

	test("asks again after a post fails, and logs only the error's name", async () => {
		let fail = true;
		const posted: string[] = [];
		const { alerts, warnings } = setup({
			sink: async (text) => {
				if (fail) throw new RangeError("secret words");
				posted.push(text);
				return true;
			},
		});
		expect(await alerts.raise("push:a", "x")).toBe(false);
		expect(warnings).toEqual([
			{
				fields: { error: "RangeError" },
				msg: "an ops alert could not be posted",
			},
		]);
		fail = false;
		expect(await alerts.raise("push:a", "x")).toBe(true);
		expect(posted).toEqual(["x"]);
	});

	test("a sink that declines gives the key and the slot back without a log line", async () => {
		let accept = false;
		const { alerts, warnings } = setup({
			kindCap: 1,
			sink: async () => accept,
		});
		expect(await alerts.raise("push:a", "x")).toBe(false);
		expect(await alerts.raise("push:b", "x")).toBe(false);
		accept = true;
		expect(await alerts.raise("push:a", "x")).toBe(true);
		expect(warnings).toEqual([]);
	});

	test("a kind cannot flood the sink; the others are not held, and the rest are counted", async () => {
		const { alerts, posted } = setup({ kindCap: 2 });
		for (const key of ["push:1", "push:2", "push:3", "push:4"])
			await alerts.raise(key, key);
		await alerts.raise("mirror:1", "mirror");
		expect(posted).toEqual(["push:1", "push:2", "mirror"]);
		const push = alerts.faults().find((fault) => fault.kind === "push");
		expect(push?.raised).toBe(4);
		expect(push?.suppressed).toBe(2);
	});

	test("info is not capped, not listed and still posted once per key", async () => {
		const { alerts, posted } = setup({ kindCap: 1 });
		await alerts.raise("join:1", "a");
		expect(await alerts.raise("join:2", "b", { info: true })).toBe(true);
		expect(await alerts.raise("join:2", "b", { info: true })).toBe(false);
		expect(posted).toEqual(["a", "b"]);
		expect(alerts.faults().map((fault) => fault.raised)).toEqual([1]);
		await alerts.raise("news:1", "c", { info: true });
		expect(alerts.faults().map((fault) => fault.kind)).toEqual(["join"]);
	});

	test("an info alert does not take a slot of its kind", async () => {
		const { alerts, posted } = setup({ kindCap: 1 });
		await alerts.raise("join:1", "info", { info: true });
		expect(await alerts.raise("join:2", "fault")).toBe(true);
		expect(posted).toEqual(["info", "fault"]);
	});

	test("lists the last fault of each kind, newest first, with its code and its name", async () => {
		const { alerts, advance } = setup({ kinds: { push: "LINE push" } });
		await alerts.raise("push:a", "x", { code: "429" });
		advance(10);
		await alerts.raise("mirror:a", "y");
		advance(10);
		await alerts.raise("push:b", "z", { code: "500" });
		expect(alerts.faults()).toEqual([
			{
				kind: "push",
				name: "LINE push",
				at: 1_000_020,
				code: "500",
				raised: 2,
				suppressed: 0,
			},
			{
				kind: "mirror",
				name: "mirror",
				at: 1_000_010,
				code: undefined,
				raised: 1,
				suppressed: 0,
			},
		]);
	});

	test("a kind named like an object property is called by itself", async () => {
		const { alerts } = setup({ kinds: {} });
		await alerts.raise("constructor:a", "x");
		expect(alerts.faults()[0]?.name).toBe("constructor");
	});

	test("a code is not kept from an earlier alert", async () => {
		const { alerts, advance } = setup();
		await alerts.raise("push:a", "x", { code: "429" });
		advance(1);
		await alerts.raise("push:b", "x");
		expect(alerts.faults()[0]?.code).toBeUndefined();
	});

	test("with no sink it records, holds the key and logs one line per window", async () => {
		const { alerts, warnings, advance } = setup({ sink: undefined });
		expect(alerts.posts).toBe(false);
		expect(await alerts.raise("push:a", "x", { code: "429" })).toBe(false);
		expect(await alerts.raise("push:a", "x")).toBe(false);
		expect(warnings).toEqual([
			{
				fields: { kind: "push", code: "429" },
				msg: "an ops alert was raised and there is no sink to post it to",
			},
		]);
		expect(alerts.faults()[0]?.raised).toBe(2);
		advance(HOUR);
		await alerts.raise("push:a", "x");
		expect(warnings).toHaveLength(2);
	});

	test("two alerts raised together for one key post once", async () => {
		const { alerts, posted } = setup();
		const results = await Promise.all([
			alerts.raise("push:a", "x"),
			alerts.raise("push:a", "x"),
		]);
		expect(results).toEqual([true, false]);
		expect(posted).toEqual(["x"]);
	});

	test("a throwing sink never throws out of raise", async () => {
		const { alerts } = setup({
			sink: () => {
				throw "not an error";
			},
		});
		expect(await alerts.raise("push:a", "x")).toBe(false);
	});

	test("posts reports whether a sink is set", () => {
		expect(setup().alerts.posts).toBe(true);
	});
});
