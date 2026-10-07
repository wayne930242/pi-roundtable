import { expect, test } from "bun:test";
import type { RouteSocket } from "pi-roundtable";
import { testPlugin } from "pi-roundtable/testing";
import { echo, health } from "./http.ts";

test("the route answers GET /healthz", async () => {
	const harness = await testPlugin(health);
	const route = harness.contribution.http?.[0];
	expect(route?.listener).toBe("public");
	const response = await route?.handle(new Request("http://localhost/healthz"));
	expect(await response?.text()).toBe("ok");
	await harness.stop();
});

test("the echo route admits a ticket's holder once and echoes what it is sent", async () => {
	const harness = await testPlugin(echo(new Set(["t-1"])));
	const websocket = harness.contribution.http?.[0]?.websocket;
	const refused = await websocket?.accept(
		new Request("http://localhost/echo?ticket=wrong"),
	);
	expect(refused instanceof Response && refused.status).toBe(401);
	const accepted = await websocket?.accept(
		new Request("http://localhost/echo?ticket=t-1"),
	);
	expect(accepted).toMatchObject({ data: { since: expect.any(Number) } });
	const replayed = await websocket?.accept(
		new Request("http://localhost/echo?ticket=t-1"),
	);
	expect(replayed instanceof Response && replayed.status).toBe(401);
	const sent: unknown[] = [];
	const socket: RouteSocket = {
		data: undefined,
		send: (message) => {
			sent.push(message);
			return "sent";
		},
		close: () => undefined,
	};
	await websocket?.message(socket, "hi");
	expect(sent).toEqual(["hi"]);
	await harness.stop();
});
