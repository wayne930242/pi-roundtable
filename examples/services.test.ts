import { expect, test } from "bun:test";
import { testPlugin } from "pi-roundtable/testing";
import { heartbeat } from "./services.ts";

test("the timer starts with the harness and stops with it", async () => {
	const first = Promise.withResolvers<void>();
	let beats = 0;
	const harness = await testPlugin(
		heartbeat(1, () => {
			beats++;
			first.resolve();
		}),
	);
	await first.promise;
	await harness.stop();
	const stoppedAt = beats;
	await Bun.sleep(20);
	expect(beats).toBe(stoppedAt);
	expect(harness.contribution.services?.[0]?.busy?.()).toEqual([]);
});
