import { expect, test } from "bun:test";
import { testPlugin } from "pi-roundtable/testing";
import { pixelAvatars } from "./providers.ts";

test("the plugin fills the images slot with PNG bytes", async () => {
	const harness = await testPlugin(pixelAvatars);
	const drawn = await pixelAvatars.providers?.images?.("a fox", []);
	expect([...(drawn?.slice(1, 4) ?? [])]).toEqual([0x50, 0x4e, 0x47]);
	await harness.stop();
});
