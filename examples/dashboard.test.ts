import { expect, test } from "bun:test";
import { testPlugin } from "pi-roundtable/testing";
import { links } from "./dashboard.ts";

test("the plugin adds one line to the dashboard", async () => {
	const harness = await testPlugin(links);
	expect(harness.contribution.dashboard).toEqual([
		"Docs: https://example.com/docs",
	]);
	await harness.stop();
});
