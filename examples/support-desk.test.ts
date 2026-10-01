import { expect, test } from "bun:test";
import { testPlugin } from "pi-roundtable/testing";
import { supportDesk } from "./support-desk.ts";

const turn = (target: string) => ({
	channel: "support:1" as const,
	target,
	author: { id: "u1", name: "Sam" },
	turnId: "t1",
	text: "check the queue",
});

test("the plugin contributes its target, with the limits its schedules and tasks obey", async () => {
	const { conversations, stop } = await testPlugin(supportDesk);
	const target = conversations.target("support");
	expect(target?.label("en")).toBe("Support desk");
	expect(target?.schedules?.perChannel).toBe(3);
	expect(target?.delegation?.maxRunning).toBe(1);
	expect(conversations.target("owner")).toBeUndefined();
	await stop();
});

test("a turn for its target runs in its channels, and any other target is skipped", async () => {
	const { conversations, stop } = await testPlugin(supportDesk);
	expect(await conversations.background(turn("support"))).toEqual({
		status: "ran",
	});
	// Nobody contributes "retired", so the router skips it before any claim is asked.
	expect(await conversations.background(turn("retired"))).toEqual({
		status: "skipped",
		reason: 'no plugin contributes the background target "retired"',
	});
	await stop();
});
