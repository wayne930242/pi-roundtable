import { beforeEach, describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SessionContext } from "../domain/sessions.ts";
import { silentLogger } from "../kernel/log.ts";
import type { AgentDirectory } from "../plugin-api/services.ts";
import { FakeChannels } from "../testing/fake-agent-channels.ts";
import { discordAgentTools } from "./agent-tools.ts";

type Registered = {
	name: string;
	execute(
		id: string,
		params: Record<string, unknown>,
	): Promise<{ content: { text?: string }[]; isError?: boolean }>;
};

const agents = [
	{ name: "infra", channelId: "11", status: "active" },
	{ name: "doctor", channelId: "13", status: "active" },
];
const groups = [{ name: "pair", channelId: "12", status: "active" }];
const directory = {
	agent: (name: string) => agents.find((a) => a.name === name),
	group: (name: string) => groups.find((g) => g.name === name),
	agentByChannel: (id: string) => agents.find((a) => a.channelId === id),
	groupByChannel: (id: string) => groups.find((g) => g.channelId === id),
} as unknown as AgentDirectory;

let channels: FakeChannels;
beforeEach(() => {
	channels = new FakeChannels();
	channels.categories = [
		{ id: "8000", name: "Notes room", channelIds: ["8001"] },
		{ id: "9001", name: "Agents", channelIds: ["11", "13"] },
		{ id: "9002", name: "Groups", channelIds: ["12"] },
	];
});

function tools(withDirectory = true, agent = true) {
	const contributions = discordAgentTools({
		channels,
		directory: () => (withDirectory ? directory : undefined),
		logger: silentLogger(),
	});
	const context = {
		speaker: () => undefined,
		turnChannel: "discord:1",
		...(agent
			? { agent: { name: "x", session: "discord:1", home: "discord:1" } }
			: {}),
	} as unknown as SessionContext;
	const found = new Map<string, Registered>();
	for (const tool of contributions)
		tool.session.snapshot().factory(context)?.({
			registerTool: (def: Registered) => found.set(def.name, def),
		} as unknown as ExtensionAPI);
	return { contributions, found };
}

const call = async (name: string, args: Record<string, unknown>) => {
	const tool = tools().found.get(name);
	if (!tool) throw new Error(`no tool ${name}`);
	const result = await tool.execute("c", args);
	return {
		text: result.content.map((p) => p.text ?? "").join(""),
		error: result.isError === true,
	};
};

const shape = () =>
	channels.categories.map((c) => `${c.name}: ${c.channelIds.join(",")}`);

describe("the tools of the agent guild's channels", () => {
	test("they keep their names, tiers and helper rule, and only agents' sessions carry them", () => {
		const { contributions, found } = tools();
		expect(
			contributions.map((t) => [t.name, t.minTier, t.withheldFromHelpers]),
		).toEqual([
			["channel_arrange", "admin", true],
			["channel_read", "member", false],
		]);
		expect([...found.keys()]).toEqual(["channel_arrange", "channel_read"]);
		expect(tools(true, false).found.size).toBe(0);
		// Not required at startup: the preflight's sessions are no agent's.
		for (const tool of contributions)
			expect(tool.session.snapshot().requiredTools).toBeUndefined();
	});

	test("channel_arrange puts the listed categories first and deletes emptied team categories", async () => {
		const said = await call("channel_arrange", {
			categories: [
				{ category: "Agents-Ops", channels: ["infra", "doctor"] },
				{ category: "Groups", channels: ["pair"] },
			],
		});
		expect(shape()).toEqual([
			"Agents-Ops: 11,13",
			"Groups: 12",
			"Notes room: 8001",
		]);
		expect(channels.arranged[0]?.remove).toEqual(["9001"]);
		expect(said.text).toContain("1 empty team categories were deleted");
		expect(said.text).toContain("- Agents-Ops: infra, doctor");
	});

	test("channel_arrange refuses a wrong entry whole and moves nothing", async () => {
		const before = shape();
		for (const [entries, pattern] of [
			[
				[{ category: "Groups-Work", channels: ["infra"] }],
				/an agent goes under Agents/,
			],
			[
				[{ category: "Agents-Work", channels: ["pair"] }],
				/a group goes under Groups/,
			],
			[
				[
					{ category: "Agents-a", channels: ["infra"] },
					{ category: "Agents-b", channels: ["infra"] },
				],
				/listed twice/,
			],
			[[{ category: "Agents", channels: ["nobody"] }], /agent_list/],
		] as const) {
			const said = await call("channel_arrange", { categories: entries });
			expect(said.error).toBe(true);
			expect(said.text).toMatch(pattern);
		}
		expect(channels.arranged).toEqual([]);
		expect(shape()).toEqual(before);
	});

	test("without an agent team a tool refuses with a text", async () => {
		const tool = tools(false).found.get("channel_arrange");
		const said = await tool?.execute("c", {
			categories: [{ category: "Agents", channels: ["infra"] }],
		});
		expect(said?.isError).toBe(true);
		expect(said?.content[0]?.text).toContain("no agent team");
	});

	test("channel_read reads a channel given as a mention, capped at 50, one line per message", async () => {
		channels.history = [
			{
				id: "55",
				author: "Sam",
				at: new Date("2026-09-27T06:03:00Z"),
				text: "remember this",
				attachments: ["log.txt"],
			},
		];
		const said = await call("channel_read", {
			channel: "<#321>",
			around: "55",
			limit: 50,
		});
		expect(channels.reads).toEqual([
			{ channelId: "321", limit: 50, around: "55" },
		]);
		expect(said.text).toBe(
			"[55] 2026-09-27 06:03 Sam: remember this [attachments: log.txt]",
		);
	});

	test("channel_read refuses a channel that is not an id", async () => {
		const said = await call("channel_read", { channel: "#notes" });
		expect(said.error).toBe(true);
		expect(said.text).toMatch(/<#id>/);
	});
});
