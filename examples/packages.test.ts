import { expect, test } from "bun:test";
import { testPlugin } from "pi-roundtable/testing";
import { webSearch } from "./packages.ts";

test("the plugin asks every session to load pi-web-access and gives every agent turn its tools", async () => {
	const harness = await testPlugin(webSearch);
	expect(harness.contribution.piPackages).toEqual(["pi-web-access"]);
	expect(harness.contribution.agentSelection?.().tools).toEqual([
		"web_search",
		"fetch_content",
		"get_search_content",
	]);
	await harness.stop();
});
