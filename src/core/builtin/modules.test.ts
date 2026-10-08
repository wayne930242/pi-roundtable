import { describe, expect, test } from "bun:test";
import type {
	ExtensionAPI,
	ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { OWNER_TARGET } from "../agents/agent-claim.ts";
import type { ConversationRecord } from "../conversations/conversation-registry.ts";
import { SYSTEM_PRINCIPAL } from "../identity/principal-store.ts";
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

/** A conversation the host recorded as one person's own. */
const privately =
	(owners: Readonly<Record<string, string>>) => async (key: ChannelKey) =>
		owners[key]
			? ({
					key,
					visibility: "private",
					principalId: owners[key],
				} as unknown as ConversationRecord)
			: undefined;

/** Runs notify in a session; the tool's answer and whether it was an error. */
async function notifyIn(
	setup: Awaited<ReturnType<typeof setUpModules>>,
	session: SessionContext,
	text = "the build is green",
) {
	const [notify] = await registered(setup, session, "notify");
	if (!notify) return undefined;
	const answer = await notify.execute("1", { text });
	return {
		text: answer.content[0]?.text ?? "",
		error: answer.isError === true,
	};
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

	test("a conversation without a chat channel reports in the creator's direct messages: the single owner's, as in 0.8", async () => {
		const setup = await setUpModules();
		const [delegate] = await registered(
			setup,
			context(undefined, OUTSIDE),
			"delegate",
		);
		await delegate?.execute("1", { title: "t", task: "look it up" });
		await setup.services.get(DELEGATION).idle();
		expect(setup.record.reportChannels).toEqual([OWNER_CHANNEL]);
		expect(setup.record.directAsked).toEqual([
			OWNER_SPEAKER.principalId,
			OWNER_SPEAKER.principalId,
		]);
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
		const session = contextOf(ANN, OUTSIDE);
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
			const session = contextOf(ANN, OUTSIDE);
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

	test("a private conversation without a chat channel has the schedule and delegation tools only when its person's direct messages take background turns", async () => {
		const offered = async (
			direct: Readonly<Record<string, ChannelKey>>,
			takesBackground: (channel: ChannelKey) => boolean = () => true,
		) => {
			const setup = await setUpModules({
				direct,
				takesBackground,
				conversations: { get: privately({ "mcp:s1": "p_ann" }) },
			});
			// The real runtime builds a private session before setting its current speaker.
			const session = { ...contextOf(ANN, "mcp:s1"), speaker: () => undefined };
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
		expect(
			await offered(
				{ p_ann: "discord:ann-dm" },
				(channel) => channel !== "discord:ann-dm",
			),
		).toEqual([]);
	});

	test("no-surface tools are absent when the creator is unknown, unreachable, or reach lookup fails", async () => {
		for (const speaker of [undefined, ANN]) {
			const setup = await setUpModules();
			const session = {
				...context(undefined, OUTSIDE),
				speaker: () => speaker,
			};
			for (const extension of ["schedules", "delegate"])
				expect(await registered(setup, session, extension)).toEqual([]);
		}
		const setup = await setUpModules({
			conversations: { get: privately({ "mcp:s1": "p_ann" }) },
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
				await registered(setup, contextOf(ANN, "mcp:s1"), extension),
			).toEqual([]);
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

describe("notify", () => {
	test("is named notify, and with only Discord's direct messages reads word for word as notify_owner did", async () => {
		const [notify, ...rest] = await registered(
			await setUpModules(),
			context(),
			"notify",
		);
		expect(rest).toEqual([]);
		expect(notify?.name).toBe("notify");
		expect((notify as unknown as { description: string }).description).toBe(
			"Send Owner a direct message on Discord. Use only when they asks to be notified or reminded by DM; your normal reply already reaches them.",
		);
	});

	test("each person's notice goes to their own direct channel, in their conversation or as the speaker of a shared one", async () => {
		const setup = await setUpModules({
			direct: { "1": OWNER_CHANNEL, p_ann: "discord:ann-dm" },
			conversations: {
				get: privately({ "other:ann": "p_ann", "other:own": "1" }),
			},
		});
		const owner = { ...OWNER_SPEAKER };
		const ann = { ...ANN, tier: "owner" as const };
		await notifyIn(setup, contextOf(owner, "other:ann"), "to ann");
		await notifyIn(setup, contextOf(ann, "other:own"), "to the owner");
		await notifyIn(setup, contextOf(ann, HOME), "to the speaker");
		expect(setup.record.notified).toEqual([
			{ principalId: "p_ann", text: "to ann" },
			{ principalId: "1", text: "to the owner" },
			{ principalId: "p_ann", text: "to the speaker" },
		]);
		expect(setup.record.ownerChannelAsked).toBe(0);
	});

	test("a private conversation of someone no direct channel reaches gets no notify", async () => {
		const setup = await setUpModules({
			conversations: { get: privately({ "other:kai": "p_kai" }) },
		});
		expect(
			await registered(setup, contextOf(OWNER_SPEAKER, "other:kai"), "notify"),
		).toEqual([]);
	});

	test("in a shared conversation, a speaker no direct channel reaches is told so, and nothing is sent", async () => {
		const setup = await setUpModules();
		const answer = await notifyIn(setup, contextOf(ANN, HOME));
		expect(answer?.error).toBe(true);
		expect(answer?.text).toContain("no direct channel");
		expect(setup.record.notified).toEqual([]);
	});

	test("the host's own turn, such as a report's, notifies the primary owner, as notify_owner did", async () => {
		const setup = await setUpModules();
		const system: Speaker = {
			id: SYSTEM_PRINCIPAL,
			name: SYSTEM_PRINCIPAL,
			tier: "owner",
			principalId: SYSTEM_PRINCIPAL,
		};
		await notifyIn(setup, contextOf(system, HOME), "the job failed");
		expect(setup.record.notified).toEqual([
			{ principalId: "1", text: "the job failed" },
		]);
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
