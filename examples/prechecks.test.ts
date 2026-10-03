import { expect, test } from "bun:test";
import { PRECHECKS, type Schedule } from "pi-roundtable";
import { fakePrechecks, servicePair, testPlugin } from "pi-roundtable/testing";
import { recoveryPrecheck } from "./prechecks.ts";

test("the precheck stays quiet on a normal reading and wakes the agent on a low one", async () => {
	const prechecks = fakePrechecks();
	let reading = { hrv: 52, baseline: 55 };
	const harness = await testPlugin(
		recoveryPrecheck(async () => reading),
		{ services: [servicePair(PRECHECKS, prechecks)] },
	);
	const precheck = prechecks.get("health.recovery");
	if (!precheck) throw new Error("the plugin registered no precheck");
	const context = {
		schedule: { id: 1, title: "recovery" } as Schedule,
		firedAt: new Date(),
		signal: new AbortController().signal,
	};
	expect(await precheck.run(context)).toEqual({
		wake: false,
		note: "HRV 52 ms, as usual.",
	});
	reading = { hrv: 31, baseline: 55 };
	expect(await precheck.run(context)).toEqual({
		wake: true,
		context: "HRV 31 ms against a baseline of 55 ms.",
	});
	await harness.stop();
});
