import { expect, test } from "bun:test";
import { testPlugin } from "pi-roundtable/testing";
import { echo } from "./channels.ts";

test("the claim owns channels of its surface and admits their messages as turns", async () => {
	const harness = await testPlugin(echo);
	const [claim] = harness.contribution.channels ?? [];
	expect(claim?.owns("echo:1")).toBe(true);
	expect(claim?.owns("discord:1")).toBe(false);
	const admitted = claim?.admit({ text: "hi" } as never);
	expect(admitted?.kind).toBe("turn");
	await harness.stop();
});
