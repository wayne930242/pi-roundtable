import { describe, expect, test } from "bun:test";
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
	type ChannelKey,
	compileSessionPlan,
	type SessionContext,
} from "../sessions.ts";
import type { Speaker } from "../speakers.ts";
import {
	ANN,
	context,
	contextOf,
	factoryOf,
	GROUP,
	HOME,
	OUTSIDE,
	privateTo,
	registered,
	scout,
	seat,
} from "../testing/module-sessions.ts";
import { OWNER_CHANNEL, setUpModules } from "../testing/modules.ts";
import { OWNER_SPEAKER } from "../testing/owner.ts";

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
		expect(toolTiers).not.toHaveProperty("notify");
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
			const setup = await setUpModules({ schedules });
			const session = context(undefined, HOME);
			const list = (
				await registered(
					setup,
					visibility === "private"
						? privateTo(session, OWNER_SPEAKER.principalId)
						: session,
					"schedules",
				)
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

	test("a conversation without a chat channel reports in the creator's direct messages: the single owner's, as in 0.8", async () => {
		const setup = await setUpModules();
		const [delegate] = await registered(
			setup,
			privateTo(context(undefined, OUTSIDE), OWNER_SPEAKER.principalId),
			"delegate",
		);
		await delegate?.execute("1", { title: "t", task: "look it up" });
		await setup.services.get(DELEGATION).idle();
		expect(setup.record.reportChannels).toEqual([OWNER_CHANNEL]);
		// Asked once, when the report needs the channel; offering the tool only asks whether one knows them.
		expect(setup.record.directAsked).toEqual([OWNER_SPEAKER.principalId]);
		expect(setup.record.ownerChannelAsked).toBe(0);
	});

	test("from a conversation without a chat channel, another person's schedules and reports go to their own direct messages, never the owner's", async () => {
		const created: { channel: ChannelKey }[] = [];
		const schedules = {
			forChannel: async () => [],
			all: async () => [],
			create: async (schedule: { channel: ChannelKey }) => {
				created.push(schedule);
				return { ...schedule, id: 7 };
			},
		} as unknown as ScheduleStore;
		const setup = await setUpModules({
			schedules,
			direct: { "1": OWNER_CHANNEL, p_ann: "discord:ann-dm" },
		});
		const session = privateTo(contextOf(ANN, OUTSIDE), "p_ann");
		const create = (await registered(setup, session, "schedules")).find(
			(tool) => tool.name === "schedule_create",
		);
		const scheduled = await create?.execute("1", {
			title: "t",
			prompt: "p",
			in_minutes: 5,
		});
		expect(scheduled?.isError).toBeFalsy();
		expect(scheduled?.content[0]?.text).toContain("Ann's direct messages");
		const [delegate] = await registered(setup, session, "delegate");
		await delegate?.execute("1", { title: "t", task: "look it up" });
		await setup.services.get(DELEGATION).idle();
		expect(created.map((schedule) => schedule.channel)).toEqual([
			"discord:ann-dm",
		]);
		expect(setup.record.reportChannels).toEqual(["discord:ann-dm"]);
		expect(setup.record.ownerChannelAsked).toBe(0);
	});

	test("creation rechecks the creator's direct channel and background claim after tools were offered", async () => {
		const created: unknown[] = [];
		const schedules = {
			forChannel: async () => [],
			all: async () => [],
			create: async (schedule: object) => {
				created.push(schedule);
				return { ...schedule, id: 7 };
			},
		} as unknown as ScheduleStore;
		for (const refusal of ["no direct channel", "background turns"]) {
			const direct: Record<string, ChannelKey> = {
				"1": OWNER_CHANNEL,
				p_ann: "discord:ann-dm",
			};
			let background = true;
			const setup = await setUpModules({
				schedules,
				direct,
				takesBackground: () => background,
			});
			const session = privateTo(contextOf(ANN, OUTSIDE), "p_ann");
			const create = (await registered(setup, session, "schedules")).find(
				(tool) => tool.name === "schedule_create",
			);
			const [delegate] = await registered(setup, session, "delegate");
			if (refusal === "no direct channel") delete direct.p_ann;
			else background = false;
			const scheduled = await create?.execute("1", {
				title: "t",
				prompt: "p",
				in_minutes: 5,
			});
			expect(scheduled?.isError).toBe(true);
			expect(scheduled?.content[0]?.text).toContain(refusal);
			const delegated = await delegate?.execute("1", {
				title: "t",
				task: "look it up",
			});
			expect(delegated?.isError).toBe(true);
			expect(delegated?.content[0]?.text).toContain(refusal);
			await setup.services.get(DELEGATION).idle();
			expect(setup.record.reportChannels).toEqual([]);
		}
		expect(created).toEqual([]);
	});

	test("offering the tools only asks whether a direct channel knows the person; the network is reached when a tool runs", async () => {
		const created: { channel: ChannelKey }[] = [];
		let online = false;
		let speaker: Speaker | undefined;
		const setup = await setUpModules({
			schedules: {
				forChannel: async () => [],
				all: async () => [],
				create: async (schedule: { channel: ChannelKey }) => {
					created.push(schedule);
					return { ...schedule, id: 7 };
				},
			} as unknown as ScheduleStore,
			direct: { p_ann: "discord:ann-dm" },
			online: () => online,
		});
		// Built between turns, while Discord is down: the tools stay, since Ann has a direct channel.
		const session = {
			...privateTo(contextOf(ANN, "mcp:s1"), "p_ann"),
			speaker: () => speaker,
		};
		const tools = [
			...(await registered(setup, session, "schedules")),
			...(await registered(setup, session, "delegate")),
			...(await registered(setup, session, "notify")),
		];
		expect(tools.map((tool) => tool.name)).toEqual(
			expect.arrayContaining(["schedule_create", "delegate_task", "notify"]),
		);
		expect(setup.record.directAsked).toEqual([]);
		online = true;
		speaker = ANN;
		const scheduled = await tools
			.find((tool) => tool.name === "schedule_create")
			?.execute("1", { title: "t", prompt: "p", in_minutes: 5 });
		expect(scheduled?.isError).toBeFalsy();
		expect(created.map((schedule) => schedule.channel)).toEqual([
			"discord:ann-dm",
		]);
		expect(setup.record.directAsked).toEqual(["p_ann"]);
	});

	test("a private conversation without a chat channel has the schedule and delegation tools only when its person has a direct channel", async () => {
		const offered = async (
			direct: Readonly<Record<string, ChannelKey>>,
			takesBackground: (channel: ChannelKey) => boolean = () => true,
		) => {
			const setup = await setUpModules({
				direct,
				takesBackground,
			});
			// The real runtime builds a private session before setting its current speaker.
			const session = {
				...privateTo(contextOf(ANN, "mcp:s1"), "p_ann"),
				speaker: () => undefined,
			};
			return [
				...(await registered(setup, session, "schedules")),
				...(await registered(setup, session, "delegate")),
			].map((tool) => tool.name);
		};
		expect(await offered({ p_ann: "discord:ann-dm" })).toContain(
			"schedule_create",
		);
		expect(await offered({ p_ann: "discord:ann-dm" })).toContain(
			"delegate_task",
		);
		expect(await offered({ "1": OWNER_CHANNEL })).toEqual([]);
		// Whether a claim takes turns there is asked when a tool runs, once the channel is known.
		expect(
			await offered(
				{ p_ann: "discord:ann-dm" },
				(channel) => channel !== "discord:ann-dm",
			),
		).toContain("schedule_create");
	});

	test("no-surface tools are absent when the conversation is not recorded private, its person has no direct channel, or the lookup fails", async () => {
		// Not recorded: whoever speaks, even the owner, whose direct messages take background turns.
		// A session outlives the turn it is built in, so a speaker never decides what it offers.
		for (const speaker of [undefined, ANN, OWNER_SPEAKER]) {
			const setup = await setUpModules();
			const session = {
				...context(undefined, OUTSIDE),
				speaker: () => speaker,
			};
			for (const extension of ["schedules", "delegate"])
				expect(factoryOf(setup, extension, session)).toBeNull();
		}
		const setup = await setUpModules({
			direct: new Proxy(
				{},
				{
					get: () => {
						throw new Error("network unavailable");
					},
				},
			),
		});
		for (const extension of ["schedules", "delegate", "notify"])
			expect(
				await registered(
					setup,
					privateTo(contextOf(ANN, "mcp:s1"), "p_ann"),
					extension,
				),
			).toEqual([]);
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
	test("gives no session notify, with no direct channel to send a notice to", async () => {
		const setup = await setUpModules({ discord: false });
		for (const session of [context(), context(undefined, HOME)])
			expect(factoryOf(setup, "notify", session)).toBeNull();
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

	test("the preflight refuses a reporter's conversation whose claim keeps its conversations private, saying what to use", async () => {
		const reporter = new ErrorReporter({
			destination: { conversation: HOME },
			app: "Roundtable",
		});
		const { plugin } = await setUpModules({
			discord: false,
			errorReporter: reporter,
			takesSystemReports: () => false,
		});
		expect(async () => plugin.preflight?.()).toThrow(
			'config ops.conversation: the claim that owns "discord:scout" keeps its conversations private to their people, so it takes no system error reports',
		);
		expect(async () => plugin.preflight?.()).toThrow("ops.agent");
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
