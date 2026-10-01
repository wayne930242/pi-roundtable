import { afterEach, describe, expect, test } from "bun:test";
import type { AgentRuntime } from "./contract/runtime.ts";
import type { ChatSurface } from "./contract/surface.ts";
import { NotLinkedError } from "./errors.ts";
import { Roundtable, type RoundtableOptions } from "./host.ts";
import { silentLogger } from "./log.ts";
import type { RoundtablePlugin } from "./plugin.ts";
import type { ConversationTurns } from "./routing/conversation-turns.ts";
import { AGENTS, type AgentServer } from "./services.ts";
import { OWNER_SPEAKER as OWNER } from "./testing/owner.ts";

/** A chat surface that connects to nothing; `extra` adds what a test observes. */
function quietSurface(
	prefix: string,
	extra: Partial<ChatSurface> = {},
): ChatSurface {
	return {
		surface: prefix,
		start: async () => undefined,
		sendReply: async () => undefined,
		...extra,
	};
}

/** Every host of the test, so one that a test leaves running never blocks the next: one runs per process. */
const hosts: Roundtable[] = [];
afterEach(async () => {
	for (const roundtable of hosts.splice(0)) await roundtable.shutdown("test");
});

function host(
	plugins: RoundtablePlugin[],
	options: Partial<RoundtableOptions> = {},
): { roundtable: Roundtable } {
	const roundtable = new Roundtable(
		{
			logger: silentLogger(),
			drain: { intervalMs: 1, limitMs: 50 },
			...options,
		},
		plugins,
	);
	hosts.push(roundtable);
	return { roundtable };
}

describe("Roundtable conversation turns", () => {
	test("turns run over the runtime and the surface once linked, and are refused during setup", async () => {
		const replies: string[] = [];
		const seen: string[] = [];
		const runtime = {
			runTurn: async (request: { kind?: string; text: string }) => {
				seen.push(`${request.kind} ${request.text}`);
				return { ok: true, text: `answer to ${request.text}` };
			},
		} as unknown as AgentRuntime;
		let turns: ConversationTurns | undefined;
		let early: unknown;
		const { roundtable } = host([
			{
				// Stands in for the agent server, which provides the runtime the turns run on.
				name: "agent-server",
				provides: [AGENTS],
				setup: (context) => {
					// SAFETY: the turns read only the runtime of the agents service.
					context.services.provide(AGENTS, {
						runtime,
					} as unknown as AgentServer);
					return { services: [{ name: "runtime" }] };
				},
			},
			{
				name: "study",
				setup: (context) => {
					turns = context.turns;
					early = context.turns
						.run({
							channel: "fake:room",
							kind: "study",
							text: "too early",
							speaker: OWNER,
						})
						.catch((error: unknown) => error);
					return {
						surfaces: [
							quietSurface("fake", {
								sendReply: async (_channel, reply) => {
									replies.push(reply.chunks.join());
								},
							}),
						],
					};
				},
			},
		]);
		await roundtable.run();
		expect(await early).toBeInstanceOf(NotLinkedError);
		expect(String(await early)).toContain(
			"conversation turns are linked once every plugin is set up",
		);
		const result = await turns?.run({
			channel: "fake:room",
			kind: "study",
			text: "hello",
			speaker: OWNER,
		});
		expect(result).toEqual({ ok: true, text: "answer to hello" });
		expect(seen).toEqual(["study hello"]);
		expect(replies).toEqual(["answer to hello"]);
	});

	test("turns on a host without the agent server's runtime are refused, naming the missing service", async () => {
		let turns: ConversationTurns | undefined;
		const { roundtable } = host([
			{
				name: "study",
				setup: (context) => {
					turns = context.turns;
					return { services: [{ name: "idle" }] };
				},
			},
		]);
		await roundtable.run();
		await expect(
			turns?.run({
				channel: "fake:room",
				kind: "study",
				text: "hello",
				speaker: OWNER,
			}),
		).rejects.toThrow("service roundtable.agents is not provided");
	});
});
