import { afterAll, beforeAll, expect, test } from "bun:test";
import { describeDb } from "pi-roundtable/testing";
import {
	agentReply,
	type Booted,
	boot,
	Client,
	GUIDE,
	ofType,
} from "./app-host.ts";

describeDb("the owner app's test host", () => {
	let app: Booted;
	beforeAll(async () => {
		app = await boot({ auth: "verifier" });
	}, 30_000);
	afterAll(async () => {
		await app.stop();
	});

	test("reset forgets the turns, scripts and stops of earlier tests and closes the sockets they left open", async () => {
		const tab = await Client.open(app, { "x-actor": "owner" });
		if (!tab) throw new Error("the owner was refused");
		await tab.take(ofType("ready"));
		app.scripts.set("left-over", async () => ({ ok: true, text: "old" }));
		tab.send({ type: "send", id: "m1", room: GUIDE, text: "left-over" });
		await tab.take(ofType("accepted"));
		// The turn starts after the message is accepted, so the host has seen it once the agent has answered.
		await tab.take(agentReply("guide"));
		app.stops.push(GUIDE);
		expect(app.clients.size).toBe(1);
		expect(app.seen.length).toBeGreaterThan(0);

		await app.reset();

		expect(app.seen).toEqual([]);
		expect(app.scripts.size).toBe(0);
		expect(app.stops).toEqual([]);
		expect(app.clients.size).toBe(0);
		const deadline = Date.now() + 3000;
		while (!tab.closed && Date.now() < deadline) await Bun.sleep(10);
		expect(tab.closed).toBeDefined();
	});

	test("a socket the test closed is no longer tracked", async () => {
		const tab = await Client.open(app, { "x-actor": "owner" });
		if (!tab) throw new Error("the owner was refused");
		expect(app.clients.has(tab)).toBe(true);
		tab.close();
		expect(app.clients.has(tab)).toBe(false);
	});
});
