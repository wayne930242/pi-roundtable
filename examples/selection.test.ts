import { expect, test } from "bun:test";
import { testPlugin } from "pi-roundtable/testing";
import { alwaysOn } from "./selection.ts";

test("every read of the selection sees the current tools", async () => {
	let tools = ["note_add"];
	const harness = await testPlugin(alwaysOn(() => tools));
	const { agentSelection } = harness.contribution;
	expect(agentSelection?.().tools).toEqual(["note_add"]);
	tools = ["note_add", "file_delete"];
	expect(agentSelection?.().tools).toEqual(["note_add", "file_delete"]);
	await harness.stop();
});
