import { describe, expect, test } from "bun:test";
import type { ResolvedRouting } from "../config/routing.ts";
import type { AgentTurnScope } from "../sessions.ts";
import type { Speaker } from "../speakers.ts";
import { TEST_OWNER } from "../testing/owner.ts";
import type { Agent } from "./agent-store.ts";
import { Routes } from "./routes.ts";
import { TeamEditing } from "./team-editing.ts";
import { discordKey } from "./team-keys.ts";
import type { TeamContext } from "./team-options.ts";

const OWNER: Speaker = {
	id: "1",
	name: "Riley",
	tier: "owner",
	principalId: "1",
};
const SCOPE: AgentTurnScope = {
	name: "coordinator",
	session: discordKey("ch-coordinator"),
	home: discordKey("ch-coordinator"),
};
const NEW_AGENT = {
	name: "scout",
	displayName: "Scout",
	prompt: "You scout.",
	task: "Look around.",
};

/**
 * A team editing over an in-memory store whose opening task is recorded: `working` is the channel
 * of the caller's turn, and `routing` the host's table, or none for the defaults.
 */
function editing(working: string | undefined, routing?: ResolvedRouting) {
	const rows = new Map<string, Agent>();
	const opened: string[] = [];
	const store = {
		agents: () => [...rows.values()],
		agent: (name: string) => rows.get(name),
		group: () => undefined,
		checkNewName: () => undefined,
		createAgent: async (input: Agent) => {
			rows.set(input.name, input);
			return input;
		},
	};
	const roomSurfaces = () => ["app"];
	const ctx = {
		options: {
			store,
			routes: new Routes({ routing, store, roomSurfaces }),
			studio: { render: async () => "r".repeat(64), url: () => "x" },
			logger: { info: () => undefined, warn: () => undefined },
			channels: { createChannel: async (name: string) => `ch-${name}` },
			surfaces: { roomSurfaces },
			queue: {
				run: async (_key: string, task: () => Promise<unknown>) => task(),
			},
			owner: TEST_OWNER,
		},
		turns: {
			speakerOf: () => OWNER,
			answerBackground: async (channel: string) => {
				opened.push(channel);
			},
			workingIn: () => working,
		},
		changed: () => undefined,
	} as unknown as TeamContext;
	return { editing: new TeamEditing(ctx), opened };
}

const create = async (f: ReturnType<typeof editing>) => {
	await f.editing.create(SCOPE, NEW_AGENT);
	await Bun.sleep(5);
	return f.opened;
};

describe("the opening task's place (R8)", () => {
	test("without routing it runs on the surface that asked, else in the agent's channel", async () => {
		expect(await create(editing("app:agent.coordinator"))).toEqual([
			"app:agent.scout",
		]);
		expect(await create(editing("discord:ch-coordinator"))).toEqual([
			"discord:ch-scout",
		]);
		expect(await create(editing(undefined))).toEqual(["discord:ch-scout"]);
	});

	test("by rule an opening task always runs in the primary place; by default the asking surface wins", async () => {
		const routing: ResolvedRouting = {
			agents: { scout: { primary: "app", opening: "primary" } },
			places: {},
		};
		expect(await create(editing("discord:ch-coordinator", routing))).toEqual([
			"app:agent.scout",
		]);
		// With the default rule the asking surface still wins, and no primary is needed to follow it.
		const byOrigin: ResolvedRouting = {
			agents: { scout: { primary: "app" } },
			places: {},
		};
		expect(await create(editing("discord:ch-coordinator", byOrigin))).toEqual([
			"discord:ch-scout",
		]);
		expect(await create(editing(undefined, byOrigin))).toEqual([
			"app:agent.scout",
		]);
	});

	test("an owner's form on a surface opens the task in that surface's room, whatever the primary place", async () => {
		const routing: ResolvedRouting = {
			agents: { "*": { primary: "discord" } },
			places: {},
		};
		const f = editing(undefined, routing);
		await f.editing.createFor(OWNER, { ...NEW_AGENT, openIn: "app" });
		await Bun.sleep(5);
		expect(f.opened).toEqual(["app:agent.scout"]);
	});
});
