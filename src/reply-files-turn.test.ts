import { expect, test } from "bun:test";
import { Type } from "typebox";
import type { AgentRuntime } from "./core/contract/runtime.ts";
import type { ChatSurface } from "./core/contract/surface.ts";
import { definePlugin, defineTool } from "./core/define.ts";
import type { OutboundReply } from "./core/domain/conversation.ts";
import { AGENTS } from "./core/services.ts";
import { OWNER_SPEAKER, servicePair, testPlugin } from "./testing.ts";

const file = { name: "drawing.png", data: new Uint8Array([1, 2, 3]) };

test("a tool's image arrives with its turn's text, not in a separate early post", async () => {
	const replies: OutboundReply[] = [];
	const surface: ChatSurface = {
		surface: "fake",
		supportsFiles: true,
		start: async () => undefined,
		sendReply: async (_channel, reply) => {
			replies.push(reply);
		},
	};
	const plugin = definePlugin({
		name: "draw-test",
		setup: () => ({
			tools: [
				defineTool({
					name: "draw_test",
					description: "Make a drawing.",
					parameters: Type.Object({}),
					minTier: "member",
					run: (_args, turn) => {
						turn.attachFile(file);
						expect(replies).toEqual([]);
						return "Drawing attached.";
					},
				}),
			],
		}),
	});
	const runtime = {
		runTurn: async () => {
			await harness.runTool("draw_test", {}, { channel: "fake:room" });
			return { ok: true, text: "Here is your drawing." };
		},
	} as unknown as AgentRuntime;
	const harness = await testPlugin(plugin, {
		surfaces: [surface],
		services: [servicePair(AGENTS, { runtime })],
	});
	try {
		const result = await harness.turns.run({
			channel: "fake:room",
			kind: "owner",
			text: "draw",
			speaker: OWNER_SPEAKER,
		});
		expect(result.ok).toBe(true);
		expect(replies).toEqual([
			{ chunks: ["Here is your drawing."], files: [file] },
		]);
	} finally {
		await harness.stop();
	}
});
