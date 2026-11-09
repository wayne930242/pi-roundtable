import { expect, test } from "bun:test";
import { Type } from "typebox";
import { definePlugin, defineTool } from "./index.ts";
import { testPlugin } from "./testing.ts";

const whereAmI = defineTool({
	name: "where_am_i",
	description: "Says the channel and speaker of the turn",
	parameters: Type.Object({}),
	minTier: "member",
	run: (_args, turn) => `${turn.channel} ${turn.speaker?.name ?? "nobody"}`,
});

test("runTool runs in the channel and for the speaker it is given, test:1 by default", async () => {
	const harness = await testPlugin(
		definePlugin({ name: "where", setup: () => ({ tools: [whereAmI] }) }),
	);
	expect(await harness.runTool("where_am_i", {})).toBe("test:1 nobody");
	expect(
		await harness.runTool(
			"where_am_i",
			{},
			{
				channel: "fake:room",
				speaker: { id: "1", name: "Ada", tier: "member", principalId: "1" },
			},
		),
	).toBe("fake:room Ada");
	await harness.stop();
});

/** A real 1x1 image: the core checks the pictures a tool returns. */
const PNG = Uint8Array.from(
	Buffer.from(
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
		"base64",
	),
);

test("runTool gives the tool the client it is given, none by default, and keeps the images a tool returns", async () => {
	const probe = defineTool({
		name: "client_probe",
		description: "Asks the client for the page status",
		parameters: Type.Object({}),
		minTier: "member",
		run: async (_args, turn) => {
			if (!turn.client) return "no client";
			const result = await turn.client.call("page_status", { a: 1 });
			return result.ok
				? { text: `got ${JSON.stringify(result.value)}`, images: result.parts }
				: `failed ${result.error}`;
		},
	});
	const harness = await testPlugin(
		definePlugin({ name: "client-probe", setup: () => ({ tools: [probe] }) }),
	);
	expect(await harness.runTool("client_probe", {})).toBe("no client");
	const calls: unknown[] = [];
	expect(
		await harness.runTool(
			"client_probe",
			{},
			{
				client: {
					names: ["page_status"],
					call: async (name, args) => {
						calls.push([name, args]);
						return {
							ok: true,
							value: { url: "u" },
							parts: [{ mimeType: "image/png", data: PNG }],
						};
					},
				},
			},
		),
	).toBe('got {"url":"u"}');
	expect(calls).toEqual([["page_status", { a: 1 }]]);
	expect(harness.images).toEqual([
		{
			channel: "test:1",
			image: { mimeType: "image/png", data: PNG },
		},
	]);
	await harness.stop();
});
