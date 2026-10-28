import { afterEach, expect, test } from "bun:test";
import { MODES } from "../services.ts";
import type { Speaker } from "../speakers.ts";
import { describeDb } from "../testing/database.ts";
import { type TestHost, testHost } from "../testing/test-host.ts";

const OWNER: Speaker = {
	id: "100000000000000001",
	name: "Ada",
	tier: "owner",
	principalId: "100000000000000001",
};

let hosts: TestHost[] = [];
afterEach(async () => {
	for (const host of hosts.splice(0)) await host.stop();
});

describeDb("the modes plugin on a host", () => {
	test("provides MODES, and a mode set before a restart is read after it", async () => {
		const room = `app:agent.guide-${crypto.randomUUID().slice(0, 8)}` as const;
		const first = await testHost({ discord: false });
		hosts.push(first);
		const modes = first.context.services.get(MODES);
		expect(modes.peek(room)).toEqual({ yolo: false, longRunning: false });
		await modes.set(room, { longRunning: true }, OWNER);
		await first.stop();
		hosts = [];

		const second = await testHost({ discord: false });
		hosts.push(second);
		expect(second.context.services.get(MODES).peek(room)).toMatchObject({
			yolo: false,
			longRunning: true,
			changedBy: OWNER.principalId,
		});
	});
});
