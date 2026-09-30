import { expect, test } from "bun:test";
import { testPlugin } from "pi-roundtable/testing";
import { turnLog } from "./events.ts";

test("the handlers record a turn, a team change, and the shutdown", async () => {
	const lines: string[] = [];
	const harness = await testPlugin(turnLog(lines));
	const { events } = harness.contribution;
	// The harness does not deliver the core's events: call the handlers with the payload the core sends.
	const turn = {
		agent: "guide",
		channel: "discord:1",
		speaker: undefined,
	} as const;
	await events?.turnStarted?.(turn);
	await events?.turnEnded?.({ ...turn, result: "ok" });
	await events?.changed?.();
	// stop() delivers shutdown(left) with an empty list, then stops the services.
	await harness.stop();
	expect(lines).toEqual([
		"guide started",
		"guide ok",
		"team changed",
		"shutdown, 0 unfinished",
	]);
});
