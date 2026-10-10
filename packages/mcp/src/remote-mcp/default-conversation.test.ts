import { expect, test } from "bun:test";
import { type AgentServer, HostStoppingError } from "pi-roundtable";
import { channelQueue } from "pi-roundtable/kit";
import { OWNER_SPEAKER } from "pi-roundtable/testing";
import { defaultConversation } from "./default-conversation.ts";

test("a remote turn asked for while the host shuts down does not run, and fails instead of rejecting", async () => {
	const queue = channelQueue();
	const ran: string[] = [];
	const conversation = defaultConversation({
		queue,
		turns: {
			run: async () => {
				ran.push("turn");
				return { ok: true, text: "answer" };
			},
		},
		server: () =>
			({
				runtime: { heldActions: async () => undefined },
				approvals: { approves: async () => false },
			}) as unknown as AgentServer,
	});
	expect(await conversation.answer("mcp:one", "hi", OWNER_SPEAKER)).toEqual({
		ok: true,
		text: "answer",
	});
	queue.close();
	const refused = await conversation.answer("mcp:one", "hi", OWNER_SPEAKER);
	expect(refused.ok).toBe(false);
	expect(!refused.ok && refused.error).toBeInstanceOf(HostStoppingError);
	expect(ran).toEqual(["turn"]);
});
