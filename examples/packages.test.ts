import { expect, test } from "bun:test";
import { testPlugin } from "pi-roundtable/testing";
import { webSearch } from "./packages.ts";

test("the plugin asks every session to load pi-web-access", async () => {
	const harness = await testPlugin(webSearch);
	expect(harness.contribution.piPackages).toEqual(["pi-web-access"]);
	await harness.stop();
});
