import { expect, test } from "bun:test";
import {
	type ContextWithSystemEvent,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { bridgeHistoryHidesMemory as publicCheck } from "../../kit/index.ts";
import { bridgeTurnRefusal } from "./bridge-guard.ts";
import {
	bridgeHistoryHidesMemoryFor,
	recordMemoryTurn,
} from "./reader-history.ts";

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
	// Disabling future memory loading cannot make retained private history safe.
	expect(
		await check(exchange("memory_search", "owner"), "guest", { memory: false }),
	).toBeDefined();
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

test("reader records attribute malformed, truncated and aborted memory calls to their turn", async () => {
	for (const shape of ["validation", "truncated", "aborted"]) {
		const history = SessionManager.inMemory("/tmp");
		history.appendCustomEntry("roundtable-conversation", {
			visibility: "shared",
		});
		history.appendCustomEntry("roundtable-memory-turn", {
			reader: "owner",
			privateMemory: false,
		});
		const messages = exchange("memory_add");
		if (shape !== "aborted") {
			const result = messages[1];
			if (result?.role === "toolResult") {
				result.isError = true;
				result.details = {};
			}
		} else messages.pop();
		for (const message of messages)
			if (message.role === "assistant" || message.role === "toolResult")
				history.appendMessage(message);
		for (const reader of ["owner", "system", "guest"]) {
			const refused = await bridgeTurnRefusal(undefined, options, {
				messages: history.buildSessionContext().messages,
				sessionManager: history,
				reader,
			});
			if (reader === "guest") expect(refused).toBeDefined();
			else expect(refused).toBeUndefined();
		}
	}
});

test("reader records guard prompt-only memory and preserve public multi-reader turns across compaction", async () => {
	for (const privateMemory of [false, true]) {
		const history = SessionManager.inMemory("/tmp");
		history.appendCustomEntry("roundtable-memory-turn", {
			reader: "ann",
			privateMemory,
		});
		history.appendMessage(
			exchange("public_tool")[0] as Extract<
				Messages[number],
				{ role: "assistant" }
			>,
		);
		const kept = history.appendMessage({
			role: "user",
			content: "public",
			timestamp: 3,
		});
		history.appendCompaction("safe summary", kept, 100);
		const refused = await bridgeTurnRefusal(undefined, options, {
			messages: history.buildSessionContext().messages,
			sessionManager: history,
			reader: "bo",
		});
		if (privateMemory) expect(refused).toBeDefined();
		else expect(refused).toBeUndefined();
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

test("the kit's bridgeHistoryHidesMemory takes a branch and a reader; the owner attribution stays in the core", () => {
	expect(publicCheck.length).toBe(2);
	const manager = SessionManager.inMemory("/tmp");
	recordMemoryTurn(manager, "owner", true);
	const branch = manager.getBranch();
	// Public form: SYSTEM is a reader of its own, so the owner's private turn hides from it.
	expect(publicCheck(branch, "system")).toBe(true);
	expect(publicCheck(branch, "owner")).toBe(false);
	// The core's form maps SYSTEM to the primary owner, as bridge turns do.
	expect(bridgeHistoryHidesMemoryFor(branch, "system", "owner")).toBe(false);
});
