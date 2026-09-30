import { expect, test } from "bun:test";
import { testPlugin } from "pi-roundtable/testing";
import { houseRules } from "./prompt.ts";

test("the section names the agent, and the speaker when there is one", async () => {
	const harness = await testPlugin(houseRules);
	const section = harness.contribution.prompt?.[0];
	const scope = {
		name: "guide",
		session: "discord:1",
		home: "discord:1",
	} as const;
	const agent = { name: "guide", displayName: "Guide" };
	expect(section?.build({ agent, speaker: undefined, scope })).toBe(
		"House rules for Guide: answer in the language you were asked in.",
	);
	expect(
		section?.build({
			agent,
			speaker: { id: "1", name: "Ada", tier: "member" },
			scope,
		}),
	).toContain("You are talking with Ada.");
	await harness.stop();
});
