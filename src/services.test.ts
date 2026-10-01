import { expect, test } from "bun:test";
import {
	AGENTS,
	type AgentDirectory,
	type AgentServer,
	type AgentTeam,
	type AvatarStudio,
	BACKGROUND_TURNS,
	type BackgroundTurns,
	DELEGATION,
	type Delegator,
	definePlugin,
	MEMORY,
	MEMORY_KINDS,
	type MemoryStore,
	SCHEDULES,
	type ScheduleStore,
	SKILLS,
	type SkillRegistry,
	type SpeakerMemory,
	TIERS,
} from "./index.ts";
import { servicePair, testPlugin } from "./testing.ts";

// Each port is an interface, so a plain object with the methods satisfies it: nothing below is cast.

const schedules: ScheduleStore = {
	create: async () => {
		throw new Error("unused");
	},
	get: async () => undefined,
	forChannel: async () => [],
	all: async () => [],
	update: async () => undefined,
	remove: async () => undefined,
	due: async () => [],
	claim: async () => true,
	recordStatus: async () => undefined,
};

const background: BackgroundTurns = {
	runScheduled: async () => ({ status: "ran" }),
	runDelegated: async () => undefined,
	runErrorReport: async () => ({ status: "ran" }),
};

const delegation: Delegator = {
	start: (request) => ({ ...request, id: 1, startedAt: new Date(0) }),
	runningChannels: () => [],
	idle: async () => undefined,
};

const speakerMemory: SpeakerMemory = {
	list: async () => [],
	forPrompt: async () => ({ core: [], events: [] }),
	add: async (fact, kind = "core") => ({
		id: 1,
		kind,
		fact,
		eventDate: null,
	}),
	search: async () => [],
	update: async () => undefined,
	removeById: async () => false,
	remove: async () => [],
};
const memory: MemoryStore = { forSpeaker: () => speakerMemory };

const skills: SkillRegistry = {
	resolve: () => ({ skills: [], missing: [] }),
	carried: () => ({ skills: [], missing: [] }),
	carriedNames: () => [],
	describeCarried: () => "",
	catalog: () => [],
	list: () => "",
	linkedFrom: () => [],
	checkRegistered: () => undefined,
	link: async () => "linked",
	attach: async () => [],
};

const directory: AgentDirectory = {
	agents: () => [],
	agent: () => undefined,
	activeAgent: (name) => {
		throw new Error(`no agent ${name}`);
	},
	agentByChannel: () => undefined,
	groups: () => [],
	group: () => undefined,
	groupByChannel: () => undefined,
};

const team: AgentTeam = {
	guildId: "guild",
	onChange: () => undefined,
	status: async () => ({ agents: [], groups: [] }),
	owns: () => undefined,
	modelOf: () => ({ model: "test/model", thinking: "off" }),
	defaultModel: () => ({ model: "test/model", thinking: "off" }),
	usableModels: async () => [],
	channelOf: (name) => `discord:${name}`,
	turnChannel: (scope) => scope.home,
	postAs: async () => undefined,
	announce: async () => undefined,
	update: async () => "updated",
	redrawAvatar: async () => {
		throw new Error("unused");
	},
};

const avatars: AvatarStudio = {
	canDraw: false,
	url: () => "https://example.com/avatar.png",
	draw: async () => "hash",
	edit: async () => "hash",
	fallback: async () => "hash",
	route: (listener) => ({
		name: "avatars",
		listener,
		path: { prefix: "/avatars/" },
		methods: ["GET"],
		handle: () => new Response("none"),
	}),
	serve: () => undefined,
};

const agents: AgentServer = {
	team,
	directory,
	runtime: {
		runTurn: async () => ({ ok: true, text: "" }),
		steer: async () => false,
		stop: () => false,
		startFresh: async () => undefined,
		deleteConversation: async () => undefined,
		pendingConfirmation: () => undefined,
		heldActions: async () => undefined,
		recentTranscript: async () => [],
	},
	approvals: { approves: async () => true },
	avatars,
};

test("objects that are not the built-in classes are what a plugin reads back for every port", async () => {
	let read: {
		schedules?: ScheduleStore;
		memory?: MemoryStore;
		team?: AgentTeam;
	} = {};
	let skillNames: string[] = [];
	const harness = await testPlugin(
		definePlugin({
			name: "reader",
			setup: ({ services }) => {
				read = {
					schedules: services.get(SCHEDULES),
					memory: services.get(MEMORY),
					team: services.get(AGENTS).team,
				};
				skillNames = services.get(SKILLS).linkedFrom("any/repo");
				services.get(BACKGROUND_TURNS);
				services.get(DELEGATION);
				services.get(AGENTS).directory;
				return { services: [{ name: "idle" }] };
			},
		}),
		{
			services: [
				servicePair(SCHEDULES, schedules),
				servicePair(BACKGROUND_TURNS, background),
				servicePair(DELEGATION, delegation),
				servicePair(MEMORY, memory),
				servicePair(SKILLS, skills),
				servicePair(AGENTS, agents),
			],
		},
	);
	expect(await read.schedules?.all()).toEqual([]);
	expect(await read.memory?.forSpeaker("1").list()).toEqual([]);
	expect(read.team?.guildId).toBe("guild");
	expect(skillNames).toEqual([]);
	await harness.stop();
});

test("the keys are frozen and named, and the memory kinds and tiers are frozen lists", () => {
	for (const key of [
		SCHEDULES,
		MEMORY,
		SKILLS,
		AGENTS,
		DELEGATION,
		BACKGROUND_TURNS,
	]) {
		expect(Object.isFrozen(key)).toBe(true);
		expect(key.id.startsWith("roundtable.")).toBe(true);
	}
	expect(MEMORY_KINDS).toEqual(["core", "note", "event"]);
	expect(Object.isFrozen(MEMORY_KINDS)).toBe(true);
	expect(TIERS).toEqual(["member", "admin", "owner"]);
	expect(Object.isFrozen(TIERS)).toBe(true);
});
