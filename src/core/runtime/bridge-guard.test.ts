import { expect, test } from "bun:test";
import {
	type ContextWithSystemEvent,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { bridgeTurnRefusal } from "./bridge-guard.ts";

type Messages = ContextWithSystemEvent["messages"];
function exchange(name: string, privateTo?: string): Messages {
	return [
		{
			role: "assistant",
			content: [
				{ type: "toolCall", id: "call", name, arguments: { secret: "SECRET" } },
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "test",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: 1,
		},
		{
			role: "toolResult",
			toolCallId: "call",
			toolName: name,
			content: [{ type: "text", text: "SECRET" }],
			details: privateTo === undefined ? undefined : { privateTo },
			isError: false,
			timestamp: 2,
		},
	];
}
const options = {
	model: { provider: "claude-bridge", id: "test" },
	memory: true,
	owner: { id: "owner" },
};
const check = (messages: Messages, reader: string | undefined, extra = {}) =>
	bridgeTurnRefusal(undefined, { ...options, ...extra }, { messages, reader });

test("bridge allows the owner and SYSTEM on owner history; guests' own history allows only that guest", async () => {
	for (const reader of ["owner", "system"]) {
		expect(
			await check(exchange("memory_search", "owner"), reader),
		).toBeUndefined();
		expect(await check(exchange("memory_search"), reader)).toBeUndefined();
	}
	expect(await check(exchange("memory_search", "owner"), "guest")).toMatch(
		/claude-bridge.*private memory/s,
	);
	expect(await check(exchange("memory_search"), "guest")).toBeDefined();
	expect(
		await check(exchange("recall_person", "guest"), "guest"),
	).toBeUndefined();
	expect(
		await check(exchange("recall_person", "guest"), "owner"),
	).toBeDefined();
	expect(await check(exchange("run_task", "owner"), "guest")).toBeDefined();
});

test("bridge refuses unowned outstanding memory calls but ignores public history and other providers", async () => {
	expect(
		await check(exchange("memory_search").slice(0, 1), "owner"),
	).toBeDefined();
	expect(await check(exchange("public_tool"), "guest")).toBeUndefined();
	expect(await check([], "guest")).toBeUndefined();
	expect(
		await check(exchange("memory_search", "owner"), "guest", {
			model: { provider: "anthropic", id: "test" },
		}),
	).toBeUndefined();
	expect(
		await check(exchange("memory_search", "owner"), "guest", { memory: false }),
	).toBeUndefined();
});

test("legacy owner compatibility stops at the first 0.9 scope record; modern unowned memory refuses even owner and SYSTEM", async () => {
	for (const modern of [false, true]) {
		const history = SessionManager.inMemory("/tmp");
		if (modern)
			history.appendCustomEntry("roundtable-conversation", {
				visibility: "shared",
			});
		for (const message of exchange("memory_search"))
			if (message.role === "assistant" || message.role === "toolResult")
				history.appendMessage(message);
		if (!modern)
			history.appendCustomEntry("roundtable-conversation", {
				visibility: "shared",
			});
		for (const reader of ["owner", "system", "guest"]) {
			const refused = await bridgeTurnRefusal(undefined, options, {
				messages: history.buildSessionContext().messages,
				sessionManager: history,
				reader,
			});
			if (!modern && reader !== "guest") expect(refused).toBeUndefined();
			else expect(refused).toBeDefined();
		}
	}
});

test("bridge agent-model switch checks the same raw history", async () => {
	const message = await bridgeTurnRefusal(
		"agent",
		{
			...options,
			model: { provider: "anthropic", id: "test" },
			agents: {
				modelOf: () => ({ model: "claude-bridge/test", thinking: "off" }),
			},
		},
		{ messages: exchange("run_task", "owner"), reader: "guest" },
	);
	expect(message).toMatch(/^agent: .*claude-bridge.*private memory/s);
});
