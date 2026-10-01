import { describe, expect, test } from "bun:test";
import type { ChannelKey, TurnResult } from "pi-roundtable";
import { AgentRunError } from "pi-roundtable";
import { silentLogger } from "pi-roundtable/testing";
import { REMOTE_MCP_MESSAGES } from "./messages.ts";
import { RemoteAgent, RemoteAgentError } from "./remote-agent.ts";

const RELAY_NOTE = REMOTE_MCP_MESSAGES.relayNote;

const logger = silentLogger();

function fakeSessions() {
	const ids = new Set<string>();
	let next = 0;
	return {
		create: async () => {
			const id = `00000000-0000-4000-8000-00000000000${next++}`;
			ids.add(id);
			return id;
		},
		touch: async (id: string) => ids.has(id),
	};
}

/** An answer that waits until the test releases it. */
function heldAnswer() {
	const seen: { channel: ChannelKey; text: string }[] = [];
	let release: (result: TurnResult) => void = () => undefined;
	const answer = (channel: ChannelKey, text: string) => {
		seen.push({ channel, text });
		return new Promise<TurnResult>((resolve) => {
			release = resolve;
		});
	};
	return { seen, answer, release: (r: TurnResult) => release(r) };
}

describe("RemoteAgent", () => {
	test("returns at once, then reports the finished run", async () => {
		const held = heldAnswer();
		const agent = new RemoteAgent({
			sessions: fakeSessions(),
			answer: held.answer,
			logger,
		});
		const { runId, sessionId } = await agent.dispatch(
			"What is on my calendar today?",
		);
		expect(agent.result(runId)).toEqual({ status: "working" });
		expect(held.seen).toEqual([
			{
				channel: `mcp:${sessionId}`,
				text: `${RELAY_NOTE}\nWhat is on my calendar today?`,
			},
		]);
		held.release({ ok: true, text: "Nothing today." });
		await Bun.sleep(0);
		expect(agent.result(runId)).toEqual({
			status: "completed",
			text: "Nothing today.",
		});
	});

	test("continues a session, but not while it has a working run", async () => {
		const held = heldAnswer();
		const agent = new RemoteAgent({
			sessions: fakeSessions(),
			answer: held.answer,
			logger,
		});
		const { sessionId } = await agent.dispatch("first");
		await expect(agent.dispatch("second", sessionId)).rejects.toEqual(
			new RemoteAgentError("RUN_IN_PROGRESS"),
		);
		held.release({ ok: false, error: new AgentRunError("boom") });
		await Bun.sleep(0);
		const second = await agent.dispatch("second", sessionId);
		expect(second.sessionId).toBe(sessionId);
	});

	test("rejects unknown sessions and runs, and hides failure details", async () => {
		const agent = new RemoteAgent({
			sessions: fakeSessions(),
			answer: async () => ({ ok: false, error: new AgentRunError("secret") }),
			logger,
		});
		await expect(
			agent.dispatch("x", "00000000-0000-4000-8000-000000000099"),
		).rejects.toEqual(new RemoteAgentError("SESSION_NOT_FOUND"));
		await expect(agent.dispatch("x", "../etc")).rejects.toEqual(
			new RemoteAgentError("SESSION_NOT_FOUND"),
		);
		expect(() => agent.result("nope")).toThrow(RemoteAgentError);
		const { runId } = await agent.dispatch("x");
		await Bun.sleep(0);
		const state = agent.result(runId);
		expect(state.status).toBe("failed");
		expect(JSON.stringify(state)).not.toContain("secret");
	});

	test("reports a run that outlives the timeout as failed", async () => {
		const agent = new RemoteAgent({
			sessions: fakeSessions(),
			answer: heldAnswer().answer,
			logger,
			timeoutMs: 5,
		});
		const { runId } = await agent.dispatch("slow");
		await Bun.sleep(20);
		expect(agent.result(runId).status).toBe("failed");
	});
});
