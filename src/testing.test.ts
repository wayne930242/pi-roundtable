import { expect, test } from "bun:test";
import { Type } from "typebox";
import { definePlugin, defineTool, ToolRefusal } from "./index.ts";
import { testPlugin } from "./testing.ts";

const note = defineTool({
	name: "note_add",
	description: "Write a note",
	parameters: Type.Object({ text: Type.String() }),
	minTier: "member",
	hold: (args) => (args.text === "danger" ? "Confirm note" : undefined),
	run: (args, turn) => {
		if (!args.text) throw new ToolRefusal("empty note");
		return `${turn.speaker?.name ?? "anonymous"}: ${args.text}`;
	},
});

test("the harness registers tools through their session factories and records tiers and holds", async () => {
	const harness = await testPlugin(
		definePlugin({ name: "notes", setup: () => ({ tools: [note] }) }),
	);
	expect(harness.tools).toEqual(["note_add"]);
	expect(harness.tiers.minTier("note_add")).toBe("member");
	expect(
		harness.contribution.holdRules?.[0]?.describe(
			"note_add",
			{ text: "danger" },
			{},
		),
	).toBe("Confirm note");
	expect(
		await harness.runTool(
			"note_add",
			{ text: "hello" },
			{ speaker: { id: "1", name: "Alice", tier: "owner" } },
		),
	).toBe("Alice: hello");
	expect(await harness.runTool("note_add", { text: "" })).toBe("empty note");
	await harness.stop();
});

test("ordinary tool errors reject the call rather than becoming model-visible refusals", async () => {
	const broken = defineTool({
		name: "broken_tool",
		description: "Fail",
		parameters: Type.Object({}),
		minTier: "owner",
		run: () => {
			throw new Error("disk unavailable");
		},
	});
	const harness = await testPlugin(
		definePlugin({ name: "broken", setup: () => ({ tools: [broken] }) }),
	);
	await expect(harness.runTool("broken_tool", {})).rejects.toThrow(
		"disk unavailable",
	);
	await harness.stop();
});

test("database and built-in services fail with the host's errors until provided", async () => {
	let databaseError = "";
	let coreError = "";
	const harness = await testPlugin(
		definePlugin({
			name: "ports",
			setup: (context) => {
				try {
					context.database();
				} catch (error) {
					databaseError = String(error);
				}
				try {
					context.core.stores;
				} catch (error) {
					coreError = String(error);
				}
				return { events: {} };
			},
		}),
	);
	expect(databaseError).toBe("PluginError: no database is configured");
	expect(coreError).toContain("core service stores is not provided yet");
	await harness.stop();
});

test("events reach the plugin and are recorded", async () => {
	const received: string[] = [];
	const harness = await testPlugin(
		definePlugin({
			name: "listener",
			setup: (context) => {
				context.events.turnStarted({
					agent: "helper",
					channel: "test:1",
					speaker: undefined,
				});
				return {
					events: {
						shutdown: () => {
							received.push("shutdown");
						},
					},
				};
			},
		}),
	);
	expect(harness.events).toEqual([
		{
			name: "turnStarted",
			turn: { agent: "helper", channel: "test:1", speaker: undefined },
		},
	]);
	await harness.stop();
	expect(received).toEqual(["shutdown"]);
});

test("a plugin that adds nothing gets the host's exact refusal", async () => {
	await expect(
		testPlugin(definePlugin({ name: "empty", setup: () => ({}) })),
	).rejects.toThrow(
		"plugin empty adds nothing. Give it a part (tools, services, channels, and so on), a migration, or a provider, or remove it.",
	);
});

test("sessions read during setup carry the host's NotLinkedError text", async () => {
	await expect(
		testPlugin(
			definePlugin({
				name: "early",
				setup: (context) => {
					context.sessions();
					return { events: {} };
				},
			}),
		),
	).rejects.toThrow(
		"session parts are linked once every plugin is set up. Call sessions() from a service's start or from a handler, not during setup.",
	);
});

test("the harness returns the agent selection a plugin contributes", async () => {
	const harness = await testPlugin(
		definePlugin({
			name: "selecting",
			setup: () => ({
				agentSelection: () => ({ tools: ["note_add"], groups: [] }),
			}),
		}),
	);
	expect(harness.contribution.agentSelection?.()).toEqual({
		tools: ["note_add"],
		groups: [],
	});
	await harness.stop();
});
