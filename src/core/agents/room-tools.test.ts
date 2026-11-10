import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { discordKey } from "../contract/discord-key.ts";
import type {
	RoomGroupsView,
	RoomLayoutService,
} from "../contract/room-layout.ts";
import type { AgentTurnScope } from "../domain/sessions.ts";
import { TEST_OWNER } from "../testing/owner.ts";
import type { Agent, AgentGroup } from "./agent-store.ts";
import { type AgentOps, agentToolsExtension } from "./agent-tools.ts";
import { NO_ROOM_GROUPS, TeamRooms } from "./team-rooms.ts";

const SCOPE: AgentTurnScope = {
	name: "coordinator",
	session: discordKey("ch-coordinator"),
	home: discordKey("ch-coordinator"),
};

const AGENTS: Record<string, Partial<Agent>> = {
	coordinator: { status: "active" },
	infra: { status: "active" },
	doctor: { status: "active" },
	old: { status: "archived" },
	temp: { status: "active", parent: "infra" },
};
const GROUPS: Record<string, Partial<AgentGroup>> = {
	pair: { status: "active" },
};
const store = {
	agent: (name: string) => AGENTS[name] as Agent | undefined,
	group: (name: string) => GROUPS[name] as AgentGroup | undefined,
};

/** A room layout in memory that records what it is asked. */
function fakeLayout(): RoomLayoutService & {
	calls: unknown[];
	state: RoomGroupsView;
} {
	const state: RoomGroupsView = {
		groups: [{ name: "Work", rooms: ["infra"] }],
		pins: ["doctor"],
	};
	const calls: unknown[] = [];
	return {
		calls,
		state,
		view: async () => state,
		place: async (name, group) => {
			calls.push(["place", name, group]);
		},
		arrange: async (entries) => {
			calls.push(["arrange", entries]);
		},
	};
}

/** The agent tools over stub ops, each callable by name and answering its text. */
function tools(layout: RoomLayoutService | undefined, withRooms = true) {
	const calls: [string, unknown[]][] = [];
	const ops = new Proxy(
		{},
		{
			get:
				(_t, key: string) =>
				async (...args: unknown[]) => {
					calls.push([key, args]);
					return key === "list" ? "Agents: ..." : "Created.";
				},
		},
	) as unknown as AgentOps;
	const run = new Map<
		string,
		(params: Record<string, unknown>) => Promise<string>
	>();
	const pi = {
		registerTool: (tool: {
			name: string;
			execute: (
				id: string,
				params: Record<string, unknown>,
			) => Promise<unknown>;
		}) =>
			run.set(tool.name, async (params) => {
				const result = (await tool.execute("id", params)) as {
					content: { text: string }[];
				};
				return result.content.map((part) => part.text).join("");
			}),
	} as unknown as ExtensionAPI;
	agentToolsExtension(ops, SCOPE, TEST_OWNER, {
		skills: false,
		channels: true,
		...(withRooms ? { rooms: new TeamRooms(store, () => layout) } : {}),
	})(pi);
	const call = (tool: string, params: Record<string, unknown>) => {
		const runner = run.get(tool);
		if (!runner) throw new Error(`no tool ${tool}`);
		return runner(params);
	};
	return { calls, call };
}

const NEW_AGENT = {
	name: "notes",
	display_name: "Notes",
	prompt: "p",
	task: "t",
};
const NEW_GROUP = {
	name: "duo",
	display_name: "Duo",
	members: ["infra", "doctor"],
};

describe("a room group on agent_create and group_create", () => {
	test("agent_create with a group makes the agent, then places its room", async () => {
		const layout = fakeLayout();
		const { calls, call } = tools(layout);
		const text = await call("agent_create", {
			...NEW_AGENT,
			group: "Research",
		});
		expect(calls.map(([key]) => key)).toEqual(["create"]);
		expect(layout.calls).toEqual([["place", "notes", "Research"]]);
		expect(text).toContain('Its room is in the app group "Research".');
	});

	test("group_create with a group places the group's room", async () => {
		const layout = fakeLayout();
		const { calls, call } = tools(layout);
		await call("group_create", { ...NEW_GROUP, group: "Work" });
		expect(calls.map(([key]) => key)).toEqual(["createGroup"]);
		expect(layout.calls).toEqual([["place", "duo", "Work"]]);
	});

	test("without a group the room stays ungrouped, whatever the category", async () => {
		const layout = fakeLayout();
		const { calls, call } = tools(layout);
		await call("agent_create", { ...NEW_AGENT, category: "Agents-Work" });
		await call("group_create", { ...NEW_GROUP, category: "Groups-Work" });
		expect(calls.map(([key]) => key)).toEqual(["create", "createGroup"]);
		expect(layout.calls).toEqual([]);
	});

	test("a group is refused before anything is made when the host has no app room list", async () => {
		for (const [layout, withRooms] of [
			[undefined, true],
			[undefined, false],
		] as const) {
			const { calls, call } = tools(layout, withRooms);
			expect(await call("agent_create", { ...NEW_AGENT, group: "Work" })).toBe(
				NO_ROOM_GROUPS,
			);
			expect(await call("group_create", { ...NEW_GROUP, group: "Work" })).toBe(
				NO_ROOM_GROUPS,
			);
			expect(calls).toEqual([]);
		}
	});

	test("a placement the app refuses leaves the agent made and says why", async () => {
		const layout = fakeLayout();
		layout.place = async () => {
			throw new Error("There are 50 folders already.");
		};
		const { calls, call } = tools(layout);
		const text = await call("agent_create", { ...NEW_AGENT, group: "More" });
		expect(calls.map(([key]) => key)).toEqual(["create"]);
		expect(text).toContain(
			"Its room stays ungrouped: There are 50 folders already.",
		);
	});
});

describe("agent_list", () => {
	test("lists the app groups with their rooms in order, and the pins, after the categories", async () => {
		const { call } = tools(fakeLayout());
		expect(await call("agent_list", {})).toBe(
			"Agents: ...\n\nApp room groups, in list order:\n- Work: infra\nPinned in the app: doctor",
		);
	});

	test("shows no app groups on a host without an app room list", async () => {
		expect(await tools(undefined).call("agent_list", {})).toBe("Agents: ...");
	});
});

describe("room_arrange", () => {
	const arrange = (layout: RoomLayoutService | undefined, groups: unknown) =>
		tools(layout).call("room_arrange", { groups });

	test("hands the groups and rooms to the app in the order given, and answers with the result", async () => {
		const layout = fakeLayout();
		const text = await arrange(layout, [
			{ group: " Life ", names: ["doctor", "pair"] },
			{ group: "Work", names: ["infra"] },
		]);
		expect(layout.calls).toEqual([
			[
				"arrange",
				[
					{ group: "Life", names: ["doctor", "pair"] },
					{ group: "Work", names: ["infra"] },
				],
			],
		]);
		expect(text).toStartWith(
			"Arranged the app's room groups.\n\nApp room groups",
		);
	});

	test("any wrong entry refuses the whole call and nothing moves", async () => {
		const cases: [unknown, string][] = [
			[
				[{ group: "Work", names: ["ghost"] }],
				'There is no agent or group "ghost"',
			],
			[[{ group: "Work", names: ["old"] }], '"old" is archived.'],
			[[{ group: "Work", names: ["temp"] }], "temp knight"],
			[
				[
					{ group: "Work", names: ["infra"] },
					{ group: "work", names: ["doctor"] },
				],
				'The group "work" is listed twice.',
			],
			[
				[
					{ group: "Work", names: ["infra"] },
					{ group: "Life", names: ["infra"] },
				],
				'"infra" is listed twice.',
			],
			[[{ group: "Work", names: [] }], "List at least one agent or group"],
			[[{ group: "  ", names: ["infra"] }], "group is required."],
			[[], "List at least one group."],
		];
		for (const [groups, refusal] of cases) {
			const layout = fakeLayout();
			expect(await arrange(layout, groups)).toContain(refusal);
			expect(layout.calls).toEqual([]);
		}
	});

	test("the app's refusal, such as Home's, is the tool's answer", async () => {
		const layout = fakeLayout();
		layout.arrange = async () => {
			throw new Error("Home stays at the top.");
		};
		expect(
			await arrange(layout, [{ group: "Work", names: ["coordinator"] }]),
		).toBe("Home stays at the top.");
	});

	test("is refused on a host without an app room list", async () => {
		expect(
			await arrange(undefined, [{ group: "Work", names: ["infra"] }]),
		).toBe(NO_ROOM_GROUPS);
	});
});
