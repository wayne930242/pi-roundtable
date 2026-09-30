import { expect, test } from "bun:test";
import { testPlugin } from "pi-roundtable/testing";
import { health } from "./http.ts";

test("the route answers GET /healthz", async () => {
	const harness = await testPlugin(health);
	const route = harness.contribution.http?.[0];
	expect(route?.listener).toBe("public");
	const response = await route?.handle(new Request("http://localhost/healthz"));
	expect(await response?.text()).toBe("ok");
	await harness.stop();
});
