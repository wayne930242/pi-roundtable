import { expect, test } from "bun:test";
import { testPlugin } from "pi-roundtable/testing";
import { library } from "./seeds.ts";

test("the plugin seeds one agent with a name, a prompt, and an avatar prompt", async () => {
	const harness = await testPlugin(library);
	expect(harness.contribution.seeds?.map((seed) => seed.name)).toEqual([
		"librarian",
	]);
	expect(harness.contribution.seeds?.[0]?.avatarPrompt).toContain("librarian");
	await harness.stop();
});
