import { expect, test } from "bun:test";
import type { Speaker } from "pi-roundtable";
import { testPlugin } from "pi-roundtable/testing";
import { notes } from "./tools.ts";

test("note_add saves a note for the speaker and refuses an empty one", async () => {
	const harness = await testPlugin(notes);
	const ada: Speaker = { id: "1", name: "Ada", tier: "member" };
	expect(harness.tools).toEqual(["note_add"]);
	expect(harness.tiers.minTier("note_add")).toBe("member");
	expect(
		await harness.runTool("note_add", { text: "milk" }, { speaker: ada }),
	).toBe("Saved note 1 for Ada.");
	expect(await harness.runTool("note_add", { text: " " })).toBe(
		"The note is empty. Ask what to save.",
	);
	await harness.stop();
});
