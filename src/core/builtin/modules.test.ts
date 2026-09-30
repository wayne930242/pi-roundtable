import { describe, expect, test } from "bun:test";
import type {
	ExtensionAPI,
	ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import {
	type AgentTurnScope,
	type ChannelKey,
	compileSessionPlan,
	type SessionContext,
} from "../sessions.ts";
import { OWNER_CHANNEL, setUpModules } from "../testing/modules.ts";

const HOME: ChannelKey = "discord:scout";
const GROUP: ChannelKey = "discord:war-room";
const OUTSIDE: ChannelKey = "party:table-1";

const scout: AgentTurnScope = { name: "scout", session: HOME, home: HOME };
const seat: AgentTurnScope = {
	name: "scout",
	session: GROUP,
	home: HOME,
	group: "war-room",
};

function context(agent?: AgentTurnScope, home?: ChannelKey): SessionContext {
	const session: SessionContext = {
		kind: agent ? "agent" : "owner",
		homeChannel: home ?? agent?.home ?? OWNER_CHANNEL,
		turnChannel: agent?.session ?? home ?? OWNER_CHANNEL,
		compaction: { wrap: (compactor) => compactor },
		speaker: () => undefined,
		runTask: async () => "report",
	};
	if (agent) session.agent = agent;
	return session;
}

interface Registered {
	name: string;
	parameters: { properties: Record<string, unknown> };
	execute(
		id: string,
		params: unknown,
	): Promise<{ content: { text: string }[]; isError?: boolean }>;
}

/** The tools one of the modules' extensions registers in a session. */
async function registered(
	setup: Awaited<ReturnType<typeof setUpModules>>,
	session: SessionContext,
	extension: string,
): Promise<Registered[]> {
	const tool = setup.contribution.sessionTools?.find(
		(candidate) => candidate.name === extension,
	);
	const factory: ExtensionFactory | null | undefined = tool
		?.snapshot()
		.factory(session);
	if (!factory) throw new Error(`no ${extension} extension`);
	const tools: Registered[] = [];
	await factory({
		registerTool: (definition: Registered) => tools.push(definition),
		on: () => undefined,
	} as unknown as ExtensionAPI);
	return tools;
}

describe("modulesPlugin", () => {
	test("adds the owner's tools in a fixed order, and the delegator to the shutdown drain", async () => {
		const setup = await setUpModules();
		const { sessionTools, services } = setup.contribution;
		expect(sessionTools?.map((tool) => tool.name)).toEqual([
			"owner-memory",
			"notify",
			"schedules",
			"delegate",
			"discord-admin",
		]);
		expect(sessionTools?.every((tool) => tool.phase === "tools")).toBe(true);
		expect(services?.map((service) => service.name)).toEqual(["delegator"]);
		expect(compileSessionPlan(sessionTools ?? []).tools).toHaveLength(5);
	});

	test("provides the background turns and the delegator to the plugins after it", async () => {
		const { core } = await setUpModules();
		expect(core.background).toBeDefined();
		expect(core.delegator.runningChannels()).toEqual([]);
	});

	test("delegate_task reports home and opens its thread in the group", async () => {
		const setup = await setUpModules();
		const [delegate] = await registered(setup, context(seat), "delegate");
		await delegate?.execute("1", { title: "t", task: "look it up" });
		await setup.core.delegator.idle();
		expect(setup.record.reportChannels).toEqual([HOME]);
		expect(setup.record.threadOrigins).toEqual([GROUP]);
		expect(setup.record.ownerChannelAsked).toBe(0);
	});

	test("a conversation without a chat channel reports in the owner's messages", async () => {
		const setup = await setUpModules();
		const [delegate] = await registered(
			setup,
			context(undefined, OUTSIDE),
			"delegate",
		);
		await delegate?.execute("1", { title: "t", task: "look it up" });
		await setup.core.delegator.idle();
		expect(setup.record.reportChannels).toEqual([OWNER_CHANNEL]);
		expect(setup.record.ownerChannelAsked).toBe(1);
	});

	test("only agent sessions may read another agent's schedules", async () => {
		const setup = await setUpModules({ agentChannelOf: () => HOME });
		const list = async (session: SessionContext) =>
			(await registered(setup, session, "schedules")).find(
				(tool) => tool.name === "schedule_list",
			);
		expect(
			Object.keys((await list(context(scout)))?.parameters.properties ?? {}),
		).toContain("agent");
		expect(
			Object.keys((await list(context()))?.parameters.properties ?? {}),
		).not.toContain("agent");
	});
});
