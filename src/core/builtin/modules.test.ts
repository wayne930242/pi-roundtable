import { describe, expect, test } from "bun:test";
import type {
	ExtensionAPI,
	ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { ErrorReporter } from "../ops/error-reporter.ts";
import { BACKGROUND_TURNS, DELEGATION } from "../services.ts";
import {
	type AgentTurnScope,
	type ChannelKey,
	compileSessionPlan,
	type SessionContext,
} from "../sessions.ts";
import { OWNER_CHANNEL, setUpModules } from "../testing/modules.ts";

const HOME: ChannelKey = "discord:scout";
const GROUP: ChannelKey = "discord:war-room";
const OUTSIDE: ChannelKey = "other:table-1";

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
			"notify",
			"schedules",
			"delegate",
		]);
		expect(sessionTools?.every((tool) => tool.phase === "tools")).toBe(true);
		expect(services?.map((service) => service.name)).toEqual(["delegator"]);
		expect(compileSessionPlan(sessionTools ?? []).tools).toHaveLength(3);
	});

	test("declares the tiers of the schedule, delegation, and web tools, and leaves notifying the owner alone", async () => {
		const { toolTiers } = (await setUpModules()).contribution;
		expect(toolTiers).toMatchObject({
			schedule_create: "admin",
			schedule_update: "admin",
			schedule_cancel: "admin",
			schedule_list: "member",
			delegate_task: "admin",
			web_search: "member",
			fetch_content: "member",
			get_search_content: "member",
		});
		expect(toolTiers).not.toHaveProperty("notify_owner");
	});

	test("provides the background turns and the delegator to the plugins after it", async () => {
		const { services } = await setUpModules();
		expect(services.get(BACKGROUND_TURNS)).toBeDefined();
		expect(services.get(DELEGATION).runningChannels()).toEqual([]);
	});

	test("delegate_task reports home and opens its thread in the group", async () => {
		const setup = await setUpModules();
		const [delegate] = await registered(setup, context(seat), "delegate");
		await delegate?.execute("1", { title: "t", task: "look it up" });
		await setup.services.get(DELEGATION).idle();
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
		await setup.services.get(DELEGATION).idle();
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

describe("modulesPlugin without Discord", () => {
	test("leaves notifying the owner out, since there are no owner's messages to send to", async () => {
		const setup = await setUpModules({ discord: false });
		expect(setup.contribution.sessionTools?.map((tool) => tool.name)).toEqual([
			"schedules",
			"delegate",
		]);
	});

	test("a conversation on a chat surface still schedules and delegates in place, without a thread", async () => {
		const setup = await setUpModules({ discord: false });
		const [delegate] = await registered(
			setup,
			context(undefined, HOME),
			"delegate",
		);
		const answer = await delegate?.execute("1", {
			title: "t",
			task: "look it up",
		});
		expect(answer?.isError).toBeFalsy();
		await setup.services.get(DELEGATION).idle();
		expect(setup.record.reportChannels).toEqual([HOME]);
		expect(setup.record.threadOrigins).toEqual([]);
	});

	test("a conversation no chat surface carries is refused, not sent to the owner's messages", async () => {
		const setup = await setUpModules({ discord: false });
		const outside = context(undefined, OUTSIDE);
		const [delegate] = await registered(setup, outside, "delegate");
		const delegated = await delegate?.execute("1", {
			title: "t",
			task: "look it up",
		});
		expect(delegated?.isError).toBe(true);
		expect(delegated?.content[0]?.text).toContain("no chat surface");
		const list = (await registered(setup, outside, "schedules")).find(
			(tool) => tool.name === "schedule_list",
		);
		const listed = await list?.execute("1", {});
		expect(listed?.isError).toBe(true);
		expect(listed?.content[0]?.text).toContain("no chat surface");
		expect(setup.record.reportChannels).toEqual([]);
	});

	test("without the owner's background target no session gets the schedule or delegation tools, since their runs could never start", async () => {
		const setup = await setUpModules({ discord: false, ownerTarget: false });
		const factoryOf = (name: string, session: SessionContext) =>
			setup.contribution.sessionTools
				?.find((tool) => tool.name === name)
				?.snapshot()
				.factory(session);
		for (const session of [context(undefined, HOME), context(scout)]) {
			expect(factoryOf("schedules", session)).toBeNull();
			expect(factoryOf("delegate", session)).toBeNull();
		}
	});
});

describe("the error reporter's conversation", () => {
	test("a reporter that names a conversation reports there once the modules start", async () => {
		const reporter = new ErrorReporter({
			destination: { conversation: HOME },
			app: "Roundtable",
		});
		reporter.record({ level: 50, msg: "it broke" });
		const setup = await setUpModules({
			discord: false,
			errorReporter: reporter,
		});
		const service = setup.contribution.services?.find(
			(candidate) => candidate.name === "error-reports",
		);
		expect(setup.record.posted).toEqual([]);
		await service?.start?.();
		await Bun.sleep(0);
		expect(setup.record.posted.map((post) => post.channel)).toEqual([HOME]);
		expect(setup.record.posted[0]?.text).toContain("it broke");
		expect(setup.record.reportChannels).toEqual([HOME]);
	});

	test("the preflight passes when a chat surface and a claim serve the reporter's conversation", async () => {
		const reporter = new ErrorReporter({
			destination: { conversation: HOME },
			app: "Roundtable",
		});
		const { plugin } = await setUpModules({
			discord: false,
			errorReporter: reporter,
		});
		await plugin.preflight?.();
	});

	test("the preflight refuses a reporter's conversation no chat surface serves, naming ops.conversation", async () => {
		const reporter = new ErrorReporter({
			destination: { conversation: OUTSIDE },
			app: "Roundtable",
		});
		const { plugin } = await setUpModules({
			discord: false,
			errorReporter: reporter,
			owns: () => true,
		});
		expect(async () => plugin.preflight?.()).toThrow(
			'config ops.conversation: no chat surface serves "other:table-1"',
		);
	});

	test("the preflight refuses a reporter's conversation no claim owns", async () => {
		const reporter = new ErrorReporter({
			destination: { conversation: HOME },
			app: "Roundtable",
		});
		const { plugin } = await setUpModules({
			discord: false,
			errorReporter: reporter,
			owns: () => false,
		});
		expect(async () => plugin.preflight?.()).toThrow(
			'config ops.conversation: no plugin\'s conversations own "discord:scout"',
		);
	});

	test("the preflight refuses a reporter's conversation when no plugin contributes the owner's background target", async () => {
		const reporter = new ErrorReporter({
			destination: { conversation: HOME },
			app: "Roundtable",
		});
		const { plugin } = await setUpModules({
			discord: false,
			ownerTarget: false,
			errorReporter: reporter,
		});
		expect(async () => plugin.preflight?.()).toThrow(
			'config ops.conversation: no plugin contributes the "owner" background target',
		);
	});

	test("the preflight refuses a reporter's conversation whose claim takes no background turns", async () => {
		const reporter = new ErrorReporter({
			destination: { conversation: HOME },
			app: "Roundtable",
		});
		const { plugin } = await setUpModules({
			discord: false,
			errorReporter: reporter,
			takesBackground: () => false,
		});
		expect(async () => plugin.preflight?.()).toThrow(
			'config ops.conversation: the claim that owns "discord:scout" takes no background turns',
		);
	});

	test("the preflight passes for a Discord conversation with Discord there", async () => {
		const reporter = new ErrorReporter({
			destination: { conversation: HOME },
			app: "Roundtable",
		});
		const { plugin } = await setUpModules({ errorReporter: reporter });
		await plugin.preflight?.();
	});

	test("the preflight passes for an ops agent, whatever serves conversations", async () => {
		const reporter = new ErrorReporter({
			destination: { agent: "ops" },
			app: "Roundtable",
		});
		const { plugin } = await setUpModules({
			errorReporter: reporter,
			ownerTarget: false,
			takesBackground: () => false,
		});
		await plugin.preflight?.();
	});
});
