import { describe, expect, test } from "bun:test";
import { AgentError } from "../domain/errors.ts";
import type { ConversationMode } from "../modes/conversation-modes.ts";
import type { AgentTurnScope, ChannelKey } from "../sessions.ts";
import type { Speaker } from "../speakers.ts";
import { TEST_OWNER } from "../testing/owner.ts";
import type { Agent } from "./agent-store.ts";
import { TeamEditing } from "./team-editing.ts";
import { agentRoomKey, discordKey } from "./team-keys.ts";
import type { TeamContext } from "./team-options.ts";

const SCOPE: AgentTurnScope = {
	name: "coordinator",
	session: discordKey("ch-coordinator"),
	home: discordKey("ch-coordinator"),
};
const OWNER: Speaker = {
	id: "1",
	name: "Riley",
	tier: "owner",
	principalId: "1",
};
const NEW_AGENT = {
	name: "scout",
	displayName: "Scout",
	prompt: "You scout.",
	task: "Look around.",
};

/** A team editing over an in-memory store, whose modes record what they are set to and by whom. */
function editing(speaker: Speaker, modes: boolean) {
	const rows = new Map<string, Agent>();
	const set: { channel: ChannelKey; mode: unknown; by: Speaker }[] = [];
	const opened: string[] = [];
	const order: string[] = [];
	const ctx = {
		options: {
			store: {
				agents: () => [...rows.values()],
				agent: (name: string) => rows.get(name),
				checkNewName: () => undefined,
				createAgent: async (input: Agent) => {
					order.push("created");
					rows.set(input.name, input);
					return input;
				},
			},
			studio: { render: async () => "r".repeat(64), url: () => "x" },
			logger: { info: () => undefined, warn: () => undefined },
			channels: { createChannel: async (name: string) => `ch-${name}` },
			surfaces: { roomSurfaces: () => ["app"] },
			skills: undefined,
			queue: {
				run: async (_key: string, task: () => Promise<unknown>) => task(),
			},
			owner: TEST_OWNER,
			...(modes
				? {
						modes: () => ({
							set: async (
								channel: ChannelKey,
								mode: ConversationMode,
								by: Speaker,
							) => {
								order.push("modes");
								set.push({ channel, mode, by });
								return mode;
							},
						}),
					}
				: {}),
		},
		turns: {
			speakerOf: () => speaker,
			answerBackground: async (channel: string) => {
				order.push("opening task");
				opened.push(channel);
			},
			workingIn: () => undefined,
		},
		changed: () => undefined,
	} as unknown as TeamContext;
	return { editing: new TeamEditing(ctx), rows, set, opened, order };
}

describe("agent_create with long_running", () => {
	test("an owner's turn turns it on for every conversation of the agent, before its opening task", async () => {
		const f = editing(OWNER, true);
		const said = await f.editing.create(SCOPE, {
			...NEW_AGENT,
			longRunning: true,
		});
		expect(said).toContain("long-running mode is on");
		expect(f.set.map((s) => s.channel)).toEqual([
			discordKey("ch-scout"),
			agentRoomKey("app", "scout"),
		]);
		expect(f.set.every((s) => s.by === OWNER)).toBe(true);
		expect(
			f.set.every((s) => (s.mode as { longRunning: boolean }).longRunning),
		).toBe(true);
		await Bun.sleep(5);
		expect(f.order).toEqual(["created", "modes", "modes", "opening task"]);
	});

	test("without it no mode is touched", async () => {
		const f = editing(OWNER, true);
		const said = await f.editing.create(SCOPE, NEW_AGENT);
		expect(said).not.toContain("long-running");
		expect(f.set).toEqual([]);
	});

	test("a turn below the owner may not, and nothing is made", async () => {
		const f = editing({ ...OWNER, tier: "admin" }, true);
		await expect(
			f.editing.create(SCOPE, { ...NEW_AGENT, longRunning: true }),
		).rejects.toThrow(/Only an owner/);
		expect(f.rows.size).toBe(0);
		expect(f.set).toEqual([]);
	});

	test("the host's own turn may not either", async () => {
		const f = editing({ ...OWNER, principalId: "system" }, true);
		await expect(
			f.editing.create(SCOPE, { ...NEW_AGENT, longRunning: true }),
		).rejects.toThrow(AgentError);
		expect(f.rows.size).toBe(0);
	});

	test("a host without conversation modes refuses it, and nothing is made", async () => {
		const f = editing(OWNER, false);
		await expect(
			f.editing.create(SCOPE, { ...NEW_AGENT, longRunning: true }),
		).rejects.toThrow(/no conversation modes/);
		expect(f.rows.size).toBe(0);
	});
});
