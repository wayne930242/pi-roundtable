import { expect, test } from "bun:test";
import {
	PluginError,
	type SessionContext,
	SKILLS,
	THE_SPEAKER,
} from "pi-roundtable";
import { servicePair, testPlugin } from "pi-roundtable/testing";
import { coding } from "./coding-plugin.ts";

function session(kind: string): SessionContext {
	return {
		kind,
		homeChannel: "test:room",
		turnChannel: "test:room",
		compaction: { wrap: (factory) => factory },
		conversation: { visibility: "shared" },
		addressee: THE_SPEAKER,
		memory: "speaker",
		speaker: () => undefined,
		runTask: async () => "",
	};
}

test("configuration errors are plugin errors and single-character model IDs are valid", () => {
	expect(() => coding({ shelfDir: "", model: "a/b" })).toThrow(PluginError);
	expect(() => coding({ shelfDir: "/tmp/unused-shelf", model: "bad" })).toThrow(
		PluginError,
	);
	expect(coding({ shelfDir: "/tmp/unused-shelf", model: "a/b" }).name).toBe(
		"coding",
	);
});

test("only owner sessions get the additional skill list extension", async () => {
	const harness = await testPlugin(
		coding({ shelfDir: "/tmp/unused-shelf", model: "a/b" }),
		{ services: [servicePair(SKILLS, { list: () => "Skills" })] },
	);
	try {
		const snapshot = harness.contribution.sessionTools
			?.find((item) => item.name === "coding-owner-skill-list")
			?.snapshot();
		expect(snapshot?.factory(session("owner"))).toBeFunction();
		expect(snapshot?.factory(session("agent"))).toBeNull();
		expect(snapshot?.factory(session("study"))).toBeNull();
	} finally {
		await harness.stop();
	}
});
