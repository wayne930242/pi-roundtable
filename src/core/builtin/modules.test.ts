import { describe, expect, test } from "bun:test";
import type {
	ExtensionAPI,
	ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { OWNER_TARGET } from "../agents/agent-claim.ts";
import type { ConversationRecord } from "../conversations/conversation-registry.ts";
import { PERSONAL_TARGET } from "../modules/background/personal-target.ts";
import { ErrorReporter } from "../ops/error-reporter.ts";
import {
	BACKGROUND_TURNS,
	DELEGATION,
	type ScheduleStore,
} from "../services.ts";
import {
	type AgentTurnScope,
	type ChannelKey,
	compileSessionPlan,
	type SessionContext,
} from "../sessions.ts";
import type { Speaker } from "../speakers.ts";
import { OWNER_CHANNEL, setUpModules } from "../testing/modules.ts";
import { OWNER_SPEAKER } from "../testing/owner.ts";

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
		// A turn of the owner's runs, as every tool call is part of one.
		speaker: () => OWNER_SPEAKER,
		runTask: async () => "report",
	};
	if (agent) session.agent = agent;
	return session;
}

/** A session of a conversation of the owner's kind whose turns are someone else's. */
function contextOf(speaker: Speaker, home: ChannelKey): SessionContext {
	return { ...context(undefined, home), speaker: () => speaker };
}

/** An admin who is not the primary owner, such as one a remote MCP token is bound to. */
const ANN: Speaker = {
	id: "p_ann",
	name: "Ann",
	tier: "admin",
	principalId: "p_ann",
};

interface Registered {
	name: string;
	parameters: { properties: Record<string, unknown> };
	execute(
		id: string,
		params: unknown,
	): Promise<{ content: { text: string }[]; isError?: boolean }>;
}

/** The extension one of the modules' session tools gives a session; null when it gives none. */
function factoryOf(
	setup: Awaited<ReturnType<typeof setUpModules>>,
	name: string,
	session: SessionContext,
): ExtensionFactory | null | undefined {
	return setup.contribution.sessionTools
		?.find((tool) => tool.name === name)
		?.snapshot()
		.factory(session);
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

	test("contributes the personal background target, named owner with 0.8's limits, on any host", async () => {
		for (const discord of [true, false]) {
			const { backgroundTargets } = (await setUpModules({ discord }))
				.contribution;
			expect(backgroundTargets).toEqual([PERSONAL_TARGET]);
		}
		expect(PERSONAL_TARGET).toMatchObject({
			name: "owner",
			schedules: { perChannel: 20, promptChars: 8_000, aheadDays: 366 },
			delegation: { maxRunning: 3 },
		});
		expect(OWNER_TARGET).toBe(PERSONAL_TARGET);
	});

	test("in a private conversation the schedule tools list only the speaker's own schedules", async () => {
		const kept = (id: number, createdById: string) => ({
			id,
			channel: HOME,
			target: "owner",
			title: `by ${createdById}`,
			prompt: "p",
			recurrence: { kind: "once", date: "2026-12-01", time: "09:00" },
			nextRun: new Date("2026-12-01T09:00:00Z"),
			createdById,
			createdByName: createdById,
			createdTier: "member",
			createdAt: new Date(0),
		});
		const schedules = {
			forChannel: async () => [
				kept(1, OWNER_SPEAKER.principalId),
				kept(2, "p_kai"),
			],
			get: async (id: number) =>
				kept(id, id === 1 ? OWNER_SPEAKER.principalId : "p_kai"),
		} as unknown as ScheduleStore;
		const listed = async (visibility?: "private" | "shared") => {
			const setup = await setUpModules({
				schedules,
				conversations: {
					get: async (key) =>
						visibility && key === HOME
							? ({
									key,
									visibility,
									principalId: OWNER_SPEAKER.principalId,
								} as unknown as ConversationRecord)
							: undefined,
				},
			});
			const list = (
				await registered(setup, context(undefined, HOME), "schedules")
			).find((tool) => tool.name === "schedule_list");
			return (await list?.execute("1", {}))?.content[0]?.text ?? "";
		};
		const own = await listed("private");
		expect(own).toContain("#1 by 1");
		expect(own).not.toContain("#2 ");
		for (const everyone of [await listed("shared"), await listed()])
			expect(everyone).toContain("#2 by p_kai");
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

	test("someone other than the primary owner neither schedules nor delegates into the owner's messages from a conversation without a chat channel", async () => {
		const created: unknown[] = [];
		const schedules = {
			forChannel: async () => [],
			all: async () => [],
			create: async (schedule: unknown) => {
				created.push(schedule);
				return { ...(schedule as object), id: 7 };
			},
		} as unknown as ScheduleStore;
		const setup = await setUpModules({ schedules });
		const session = contextOf(ANN, OUTSIDE);
		const create = (await registered(setup, session, "schedules")).find(
			(tool) => tool.name === "schedule_create",
		);
		const scheduled = await create?.execute("1", {
			title: "t",
			prompt: "p",
			in_minutes: 5,
		});
		expect(scheduled?.isError).toBe(true);
		expect(scheduled?.content[0]?.text).toContain("owner's");
		const [delegate] = await registered(setup, session, "delegate");
		const delegated = await delegate?.execute("1", {
			title: "t",
			task: "look it up",
		});
		expect(delegated?.isError).toBe(true);
		await setup.services.get(DELEGATION).idle();
		expect(created).toEqual([]);
		expect(setup.record.reportChannels).toEqual([]);
		expect(setup.record.ownerChannelAsked).toBe(0);
	});

	test("a conversation without a chat channel the host has no record of lists only the speaker's own schedules", async () => {
		const kept = (id: number, createdById: string) => ({
			id,
			channel: OWNER_CHANNEL,
			target: "owner",
			title: `by ${createdById}`,
			prompt: `PROMPT OF ${createdById}`,
			recurrence: { kind: "once", date: "2026-12-01", time: "09:00" },
			nextRun: new Date("2026-12-01T09:00:00Z"),
			createdById,
			createdByName: createdById,
			createdTier: "owner",
			createdAt: new Date(0),
		});
		const schedules = {
			forChannel: async (channel: ChannelKey) =>
				channel === OWNER_CHANNEL
					? [kept(1, OWNER_SPEAKER.principalId), kept(2, "p_kai")]
					: [],
			get: async (id: number) =>
				kept(id, id === 1 ? OWNER_SPEAKER.principalId : "p_kai"),
		} as unknown as ScheduleStore;
		const setup = await setUpModules({
			schedules,
			conversations: { get: async () => undefined },
		});
		const list = (
			await registered(setup, context(undefined, OUTSIDE), "schedules")
		).find((tool) => tool.name === "schedule_list");
		const listed = (await list?.execute("1", {}))?.content[0]?.text ?? "";
		expect(listed).toContain("#1 by 1");
		expect(listed).not.toContain("#2 ");
		const read = await list?.execute("1", { id: 2 });
		expect(read?.isError).toBe(true);
		expect(read?.content[0]?.text).not.toContain("PROMPT OF p_kai");
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

	test("a conversation no chat surface carries gets no schedule or delegation tools, with no owner's messages to post its runs in", async () => {
		const setup = await setUpModules({ discord: false, owns: () => true });
		const outside = context(undefined, OUTSIDE);
		expect(factoryOf(setup, "schedules", outside)).toBeNull();
		expect(factoryOf(setup, "delegate", outside)).toBeNull();
		expect(setup.record.reportChannels).toEqual([]);
	});

	test("a conversation whose claim takes no background turns gets no schedule or delegation tools, since their runs could never start", async () => {
		const setup = await setUpModules({
			discord: false,
			takesBackground: () => false,
		});
		for (const session of [context(undefined, HOME), context(scout)]) {
			expect(factoryOf(setup, "schedules", session)).toBeNull();
			expect(factoryOf(setup, "delegate", session)).toBeNull();
		}
	});

	test("a headless conversation whose claim takes background turns schedules and delegates in place", async () => {
		const setup = await setUpModules({ discord: false });
		for (const session of [context(undefined, HOME), context(scout)]) {
			expect(factoryOf(setup, "schedules", session)).not.toBeNull();
			expect(factoryOf(setup, "delegate", session)).not.toBeNull();
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
