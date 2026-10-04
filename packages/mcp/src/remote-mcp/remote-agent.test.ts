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

	test.each([false, true])(
		"releases a session after an unexpected answer error (async: %s)",
		async (asyncFailure) => {
			const agent = new RemoteAgent({
				sessions: fakeSessions(),
				answer: () => {
					if (asyncFailure) return Promise.reject(new Error("unexpected"));
					throw new Error("unexpected");
				},
				logger,
			});
			const first = await agent.dispatch("first");
			await Bun.sleep(0);
			expect(agent.result(first.runId).status).toBe("failed");
			const next = await agent.dispatch("next", first.sessionId);
			await Bun.sleep(0);
			expect(agent.result(next.runId).status).toBe("failed");
		},
	);

	test("reserves a session atomically for simultaneous dispatches", async () => {
		const sessions = fakeSessions();
		const sessionId = await sessions.create();
		const releases: ((result: TurnResult) => void)[] = [];
		const agent = new RemoteAgent({
			sessions,
			answer: () =>
				new Promise<TurnResult>((resolve) => releases.push(resolve)),
			logger,
		});
		try {
			const results = await Promise.allSettled([
				agent.dispatch("first", sessionId),
				agent.dispatch("second", sessionId),
			]);
			expect(
				results.filter((result) => result.status === "fulfilled"),
			).toHaveLength(1);
			expect(
				results.find((result) => result.status === "rejected"),
			).toMatchObject({
				status: "rejected",
				reason: new RemoteAgentError("RUN_IN_PROGRESS"),
			});
		} finally {
			for (const release of releases) release({ ok: true, text: "done" });
			await Bun.sleep(0);
		}
	});

	test("keeps a timed-out session busy until the underlying answer settles", async () => {
		const held = heldAnswer();
		const agent = new RemoteAgent({
			sessions: fakeSessions(),
			answer: held.answer,
			logger,
			timeoutMs: 5,
			keepMs: 0,
		});
		const { runId, sessionId } = await agent.dispatch("slow");
		await Bun.sleep(20);
		expect(agent.result(runId).status).toBe("failed");
		await expect(agent.dispatch("overlap", sessionId)).rejects.toEqual(
			new RemoteAgentError("RUN_IN_PROGRESS"),
		);
		held.release({ ok: true, text: "late" });
		await Bun.sleep(0);
		expect(agent.result(runId).status).toBe("failed");
		const next = await agent.dispatch("next", sessionId);
		expect(next.sessionId).toBe(sessionId);
		held.release({ ok: true, text: "done" });
		await Bun.sleep(0);
	});
});
