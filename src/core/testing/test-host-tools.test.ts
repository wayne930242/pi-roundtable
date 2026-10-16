import { afterEach, describe, expect, test } from "bun:test";
import { Type } from "typebox";
import { definePlugin, defineTool, ToolRefusal } from "../define.ts";
import { PluginError } from "../errors.ts";
import { describeDb } from "./database.ts";
import { hasWebAccess, type TestHost, testHost } from "./test-host.ts";

const SPEAKER = {
	id: "1",
	name: "Alice",
	tier: "member",
	principalId: "1",
} as const;

const note = defineTool({
	name: "host_note",
	description: "Writes a note",
	parameters: Type.Object({ text: Type.String() }),
	minTier: "member",
	hold: (args, turn) =>
		args.text === "danger"
			? `Confirm ${turn.speaker?.name ?? "nobody"} on ${turn.channel}`
			: undefined,
	run: (args, turn) =>
		`${turn.speaker?.name ?? "anonymous"} on ${turn.channel} via ${turn.origin ?? "nowhere"}: ${args.text}`,
});

const refuse = defineTool({
	name: "host_refuse",
	description: "Refuses",
	parameters: Type.Object({}),
	minTier: "member",
	run: () => {
		throw new ToolRefusal("not now");
	},
});

let host: TestHost | undefined;
afterEach(async () => {
	await host?.stop();
	host = undefined;
});

const boot = () =>
	testHost({
		plugins: [
			definePlugin({
				name: "host-notes",
				setup: () => ({ tools: [note, refuse] }),
			}),
		],
	});

// Runs against a real PostgreSQL, only when ROUNDTABLE_TEST_DATABASE_URL is set and the delegation worker can load.
(hasWebAccess() ? describeDb : describe.skip)(
	"TestHost.runTool and hold",
	() => {
		test("runTool runs a contributed tool as the speaker on the channel, and on the owner's channel by default", async () => {
			host = await boot();
			expect(await host.runTool("host_note", { text: "hi" })).toBe(
				"anonymous on discord:owner-dm via nowhere: hi",
			);
			expect(
				await host.runTool(
					"host_note",
					{ text: "hi" },
					{
						speaker: SPEAKER,
						channel: "fake:room",
						origin: "https://chat.example.com",
					},
				),
			).toBe("Alice on fake:room via https://chat.example.com: hi");
		});

		test("runTool gives a refusal back as the text the model reads", async () => {
			host = await boot();
			expect(await host.runTool("host_refuse", {})).toBe("not now");
		});

		test("runTool names a tool no plugin added", async () => {
			host = await boot();
			await expect(host.runTool("host_nothing", {})).rejects.toThrow(
				PluginError,
			);
			await expect(host.runTool("host_nothing", {})).rejects.toThrow(
				"tool host_nothing is not registered",
			);
		});

		test("hold shows what the tool's hold describes for the speaker and channel, and undefined for a call that runs freely", async () => {
			host = await boot();
			expect(await host.hold("host_note", { text: "hi" })).toBeUndefined();
			expect(
				await host.hold(
					"host_note",
					{ text: "danger" },
					{ speaker: SPEAKER, channel: "fake:room" },
				),
			).toBe("Confirm Alice on fake:room");
			expect(await host.hold("host_note", { text: "danger" })).toBe(
				"Confirm nobody on discord:owner-dm",
			);
		});
	},
);
