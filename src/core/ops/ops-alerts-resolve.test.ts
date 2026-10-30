import { describe, expect, test } from "bun:test";
import type { Logger } from "../log.ts";
import {
	type OpsAlert,
	OpsAlerts,
	type OpsResolution,
	type OpsSink,
} from "./ops-alerts.ts";

function setup(sink: OpsSink | undefined, options: { windowMs?: number } = {}) {
	let now = 1_000_000;
	const warnings: { fields: unknown; msg: string }[] = [];
	const logger = {
		warn: (fields: unknown, msg: string) => warnings.push({ fields, msg }),
	} as unknown as Logger;
	const alerts = new OpsAlerts({
		logger,
		now: () => now,
		...options,
		...(sink ? { sink } : {}),
	});
	return {
		alerts,
		warnings,
		advance: (ms: number) => {
			now += ms;
		},
	};
}

/** A sink that records what it was given, with a `resolved` hook. */
function recording() {
	const alertsSeen: { text: string; alert: OpsAlert }[] = [];
	const resolutions: OpsResolution[] = [];
	const sink: OpsSink = Object.assign(
		async (text: string, alert: OpsAlert) => {
			alertsSeen.push({ text, alert });
			return true;
		},
		{
			resolved: (event: OpsResolution) => {
				resolutions.push(event);
			},
		},
	);
	return { sink, alertsSeen, resolutions };
}

describe("OpsAlerts structured sink", () => {
	test("passes the kind, key, code, info and severity beside the text", async () => {
		const { sink, alertsSeen } = recording();
		const { alerts } = setup(sink);
		await alerts.raise("sync:a", "one", { code: "429", severity: "critical" });
		await alerts.raise("news:b", "two", { info: true });
		await alerts.raise("plain:c", "three");
		expect(alertsSeen).toEqual([
			{
				text: "one",
				alert: {
					kind: "sync",
					key: "sync:a",
					code: "429",
					severity: "critical",
				},
			},
			{ text: "two", alert: { kind: "news", key: "news:b", info: true } },
			{ text: "three", alert: { kind: "plain", key: "plain:c" } },
		]);
	});

	test("a sink written for the text alone still works", async () => {
		const seen: string[] = [];
		const { alerts } = setup(async (text) => {
			seen.push(text);
			return true;
		});
		expect(await alerts.raise("sync:a", "old style")).toBe(true);
		expect(seen).toEqual(["old style"]);
		// It has no `resolved`: resolving still releases the key and does not fail.
		expect(await alerts.resolve("sync:a")).toBe(true);
		expect(await alerts.raise("sync:a", "again")).toBe(true);
		expect(seen).toEqual(["old style", "again"]);
	});
});

describe("OpsAlerts.resolve", () => {
	test("releases the key, calls resolved once and marks the kind cleared", async () => {
		const { sink, resolutions } = recording();
		const { alerts, advance } = setup(sink);
		await alerts.raise("sync:a", "x");
		expect(alerts.faults()[0]?.clearedAt).toBeUndefined();
		advance(5);
		expect(await alerts.resolve("sync:a")).toBe(true);
		expect(resolutions).toEqual([{ kind: "sync", key: "sync:a" }]);
		expect(alerts.faults()[0]?.clearedAt).toBe(1_000_005);
		// The key is free inside the window: a new fault under it posts again and is no longer cleared.
		expect(await alerts.raise("sync:a", "back")).toBe(true);
		expect(alerts.faults()[0]?.clearedAt).toBeUndefined();
	});

	test("is idempotent", async () => {
		const { sink, resolutions } = recording();
		const { alerts } = setup(sink);
		await alerts.raise("sync:a", "x");
		expect(await alerts.resolve("sync:a")).toBe(true);
		expect(await alerts.resolve("sync:a")).toBe(false);
		expect(resolutions).toHaveLength(1);
	});

	test("an unknown key, an info key and a key that never posted do nothing", async () => {
		const { sink, resolutions } = recording();
		const { alerts } = setup(sink);
		expect(await alerts.resolve("nothing:here")).toBe(false);
		await alerts.raise("news:a", "x", { info: true });
		expect(await alerts.resolve("news:a")).toBe(false);
		const declined = setup(
			Object.assign(async () => false, { resolved: () => {} }),
		);
		await declined.alerts.raise("sync:a", "x");
		expect(await declined.alerts.resolve("sync:a")).toBe(false);
		expect(resolutions).toEqual([]);
	});

	test("still resolves after the window has passed", async () => {
		const { sink, resolutions } = recording();
		const { alerts, advance } = setup(sink);
		await alerts.raise("sync:a", "x");
		advance(2 * 3_600_000);
		expect(await alerts.resolve("sync:a")).toBe(true);
		expect(resolutions).toHaveLength(1);
	});

	test("a kind is cleared only when none of its alerts is open", async () => {
		const { sink } = recording();
		const { alerts } = setup(sink);
		await alerts.raise("sync:a", "x");
		await alerts.raise("sync:b", "y");
		await alerts.resolve("sync:a");
		expect(alerts.faults()[0]?.clearedAt).toBeUndefined();
		await alerts.resolve("sync:b");
		expect(alerts.faults()[0]?.clearedAt).toBeDefined();
	});

	test("a throwing resolved is logged by name and never thrown", async () => {
		const { alerts, warnings } = setup(
			Object.assign(async () => true, {
				resolved: () => {
					throw new RangeError("secret words");
				},
			}),
		);
		await alerts.raise("sync:a", "x");
		expect(await alerts.resolve("sync:a")).toBe(true);
		expect(warnings).toEqual([
			{
				fields: { error: "RangeError" },
				msg: "an ops alert's recovery could not be posted",
			},
		]);
	});

	test("with no sink nothing is resolved", async () => {
		const { alerts } = setup(undefined);
		await alerts.raise("sync:a", "x");
		expect(await alerts.resolve("sync:a")).toBe(false);
	});
});
