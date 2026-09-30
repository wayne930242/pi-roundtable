import { expect, test } from "bun:test";
import { testPlugin } from "pi-roundtable/testing";
import { clock } from "./session-tools.ts";

test("the factory registers clock_now in a session", async () => {
	const harness = await testPlugin(clock);
	const [tool] = harness.contribution.sessionTools ?? [];
	const registered: string[] = [];
	const session = {
		kind: "agent",
		homeChannel: "test:1",
		turnChannel: "test:1",
		compaction: { wrap: (factory: unknown) => factory },
		speaker: () => undefined,
		runTask: async () => "",
	} as never;
	// A stand-in for Pi's extension API: it keeps the names registered.
	const pi = {
		registerTool: ({ name }: { name: string }) => registered.push(name),
	};
	tool?.snapshot().factory(session)?.(pi as never);
	expect(registered).toEqual(["clock_now"]);
	await harness.stop();
});
