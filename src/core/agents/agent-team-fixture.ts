import { beforeEach } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQL } from "bun";
import type { ContextUse } from "../contract/runtime.ts";
import { NO_ATTACHMENTS } from "../domain/attachment.ts";
import type {
	ChannelKey,
	PendingConfirmation,
	TurnResult,
} from "../domain/conversation.ts";
import { AgentRunError } from "../domain/errors.ts";
import type { TurnRequest } from "../domain/ports.ts";
import { silentLogger } from "../log.ts";
import { StoredSkillRegistry as SkillRegistry } from "../modules/skills/skill-registry.ts";
import { SkillStore } from "../modules/skills/skill-store.ts";
import type { PromptSection } from "../plugin.ts";
import { type ChannelQueue, channelQueue } from "../routing/channel-queue.ts";
import {
	openTestStore,
	TEST_GUILD,
	type TestStore,
	testDatabaseUrl,
} from "../testing/database.ts";
import { useTestLocale } from "../testing/locale.ts";
import { OWNER_SPEAKER, TEST_OWNER } from "../testing/owner.ts";
import type {
	AgentCategory,
	AgentChannels,
	AgentPost,
	AgentTurnRunner,
	CategoryLayout,
	ChannelMessage,
} from "./agent-ports.ts";
import type { AgentSeed } from "./agent-rules.ts";
import { PgAgentStore as AgentStore } from "./agent-store.ts";
import { DiscordAgentTeam as AgentTeam } from "./agent-team.ts";
import { discordKey } from "./team-keys.ts";

export const ENTRY = "1000";
export const USABLE = [
	"claude-bridge/claude-opus-5-5",
	"openai-codex/gpt-6-sol",
];

export class FakeChannels implements AgentChannels {
	posts: { channelId: string; post: AgentPost }[] = [];
	created: string[] = [];
	deleted = new Set<string>();
	#next = 2000;
	async post(channelId: string, post: AgentPost) {
		this.posts.push({ channelId, post });
	}
	/** The server's categories in order, each with its channels in order. */
	categories: CategoryLayout[] = [];
	#nextCategory = 9000;
	arranged: { layout: CategoryLayout[]; remove: string[] }[] = [];
	categoryOf(channelId: string) {
		return this.categories.find((c) => c.channelIds.includes(channelId))?.name;
	}
	/** Moves a channel to the end of the category, made when missing. */
	put(channelId: string, category: AgentCategory) {
		for (const c of this.categories)
			c.channelIds = c.channelIds.filter((id) => id !== channelId);
		let found = this.categories.find((c) => c.name === category);
		if (!found) {
			found = {
				id: String(this.#nextCategory++),
				name: category,
				channelIds: [],
			};
			this.categories.push(found);
		}
		found.channelIds.push(channelId);
	}
	async createChannel(name: string, topic: string, category: AgentCategory) {
		this.created.push(name);
		const id = String(this.#next++);
		this.topics.set(id, topic);
		this.put(id, category);
		return id;
	}
	async placeIn(channelId: string, category: AgentCategory) {
		if (this.categoryOf(channelId) === category) return false;
		this.put(channelId, category);
		return true;
	}
	async layout() {
		return structuredClone(this.categories);
	}
	async arrange(layout: CategoryLayout[], remove: string[]) {
		this.arranged.push({ layout: structuredClone(layout), remove });
		this.categories = layout.map((c) => ({
			id: c.id ?? String(this.#nextCategory++),
			name: c.name,
			channelIds: [...c.channelIds],
		}));
	}
	history: ChannelMessage[] = [];
	reads: { channelId: string; limit: number; around?: string }[] = [];
	async read(channelId: string, options: { limit: number; around?: string }) {
		this.reads.push({ channelId, ...options });
		return this.history;
	}
	topics = new Map<string, string>();
	async setTopic(channelId: string, topic: string) {
		this.topics.set(channelId, topic);
	}
	async exists(channelId: string) {
		return !this.deleted.has(channelId);
	}
	webhooksRemoved: string[] = [];
	async removeWebhook(channelId: string) {
		this.webhooksRemoved.push(channelId);
	}
	texts(channelId: string) {
		return this.posts
			.filter((p) => p.channelId === channelId)
			.map((p) => `${p.post.name}: ${p.post.chunks.join("")}`);
	}
}

/** Answers every turn with a scripted reply; records what each turn received. */
export class FakeRuntime implements AgentTurnRunner {
	turns: TurnRequest[] = [];
	reply: (request: TurnRequest) => string = (r) => `${r.agent?.name} ok`;
	held = new Map<ChannelKey, PendingConfirmation>();
	fresh: ChannelKey[] = [];
	/** Runs inside a turn, like a tool call the model makes. */
	during?: (request: TurnRequest) => unknown;
	/** The next turn ends as if the owner pressed stop. */
	stopNext = false;
	async runTurn(request: TurnRequest): Promise<TurnResult> {
		this.turns.push(request);
		await this.during?.(request);
		if (this.stopNext) {
			this.stopNext = false;
			return {
				ok: false,
				error: new AgentRunError("stopped by the owner"),
				stopped: true,
			};
		}
		return { ok: true, text: this.reply(request) };
	}
	async heldActions(session: ChannelKey) {
		return this.held.get(session);
	}
	async startFresh(session: ChannelKey) {
		this.fresh.push(session);
	}
	usage = new Map<ChannelKey, ContextUse>();
	contextUsage(session: ChannelKey) {
		return this.usage.get(session);
	}
}

// CI runs the setup below about ten times slower than a laptop, and bun's 5 s hook limit
// left a timed-out hook running while the next test dropped its tables.
export const HOOK_TIMEOUT_MS = 30_000;

// Runs against a real PostgreSQL, only when ROUNDTABLE_TEST_DATABASE_URL is set.
let store: TestStore<AgentStore>;
let channels: FakeChannels;
let runtime: FakeRuntime;
export interface TeamFixture {
	store: TestStore<AgentStore>;
	channels: FakeChannels;
	runtime: FakeRuntime;
	queue: ChannelQueue;
	team: AgentTeam;
	skillStore: TestStore<SkillStore>;
	skills: SkillRegistry;
}

/** The fixture of the running test; set by `useTeamFixture` before each test. */
export const fx = {} as TeamFixture;

/** What the team reads from its plugins and its scorer; tests set it. */
export const script: {
	/** The relevance scores the scorer answers with. */
	scores: Record<string, number> | undefined;
	/** The prompt sections plugins add. */
	prompt: PromptSection[];
	/** The tools plugins defined for agents. */
	tools: string[];
} = { scores: undefined, prompt: [], tools: [] };
let queue: ChannelQueue;
let team: AgentTeam;
let skillStore: TestStore<SkillStore>;
let skills: SkillRegistry;
export const removedSchedules: number[] = [];
export const stops: string[] = [];
/** The events the team reported, in order, as `turnStarted infra`, `turnEnded infra ok`, or `changed`. */
export const eventLog: string[] = [];

/** What a plugin adds to every agent's tools: a tool of its own and a group of another server's. */
const PLUGIN_SELECTION = { tools: ["memory_add"], groups: ["workspace"] };

/** The team a fresh database starts with: a coordinator in the entry channel, then two specialists. */
function seeds(entryChannelId: string): AgentSeed[] {
	return [
		{
			name: "coordinator",
			displayName: "Coordinator",
			channelId: entryChannelId,
			prompt:
				"You are the chief of staff of the owner's agent team. You hand work that belongs to a specialist to that agent with message_agent, one owner per task, and propose a new agent when a lasting responsibility has no owner.",
			avatarPrompt: "A chief of staff mid-command, pointing the way.",
		},
		{
			name: "doctor",
			displayName: "Doctor",
			prompt:
				"You keep the owner's agents healthy: read an agent's prompt with agent_get, find the instruction that caused a misbehavior, and fix it with agent_update.",
			avatarPrompt: "A bot doctor holding up a giant stethoscope.",
		},
		{
			name: "infra",
			displayName: "Infra",
			prompt:
				"You manage the owner's servers. Check before you change: read state first, state what you will change and why, then act.",
			avatarPrompt: "An infra engineer battling a server rack.",
		},
	];
}

/**
 * Waits until every queued channel task has settled and every active agent has its avatar,
 * which startup draws in the background; a fixed sleep was too short on a slow runner.
 */
export async function settle(): Promise<void> {
	const deadline = Date.now() + 10_000;
	const quiet = () =>
		queue.busy().length === 0 &&
		store.agents().every((a) => a.status !== "active" || a.avatarHash);
	while (!quiet() && Date.now() < deadline) await Bun.sleep(5);
	// Work the last task queued is still finishing.
	await Bun.sleep(20);
}

/** Registers the fixture's per-test setup in the describe it is called from. */
export function useTeamFixture(): void {
	beforeEach(async () => {
		// The expected texts are the neutral English catalog's.
		useTestLocale();
		await store?.close();
		await skillStore?.close();
		const admin = new SQL(testDatabaseUrl);
		for (const table of [
			"agents",
			"agent_groups",
			"agent_group_messages",
			"agent_group_cursors",
			"skills",
			"skill_groups",
			"agent_skills",
		])
			await admin.unsafe(`DROP TABLE IF EXISTS ${table}`);
		await admin.close();
		store = await openTestStore(AgentStore, TEST_GUILD);
		const skillDir = mkdtempSync(join(tmpdir(), "roundtable-team-skills-"));
		mkdirSync(join(skillDir, "repos/acme/kit/.git"), { recursive: true });
		mkdirSync(join(skillDir, "repos/acme/kit/skills/kit-do"), {
			recursive: true,
		});
		writeFileSync(
			join(skillDir, "repos/acme/kit/skills/kit-do/SKILL.md"),
			"---\nname: kit-do\ndescription: Use when changing source.\n---\n",
		);
		mkdirSync(join(skillDir, "builtin/writing-skills"), { recursive: true });
		writeFileSync(
			join(skillDir, "builtin/writing-skills/SKILL.md"),
			"---\nname: writing-skills\ndescription: Use when creating, editing, or reviewing a skill.\n---\n",
		);
		skillStore = await openTestStore(SkillStore, TEST_GUILD);
		skills = new SkillRegistry({
			store: skillStore,
			reposDir: join(skillDir, "repos"),
			writtenDir: join(skillDir, "skills"),
			builtinDir: join(skillDir, "builtin"),
			logger: silentLogger(),
		});
		skills.init();
		await skills.link("acme/kit", "skills");
		channels = new FakeChannels();
		runtime = new FakeRuntime();
		script.scores = undefined;
		script.prompt = [];
		script.tools = [];
		queue = channelQueue();
		removedSchedules.length = 0;
		stops.length = 0;
		eventLog.length = 0;
		team = new AgentTeam({
			owner: TEST_OWNER,
			shellUser: "mcops",
			guildId: "1",
			entryChannelId: ENTRY,
			seeds: () => seeds(ENTRY),
			store,
			channels,
			studio: {
				url: (hash) => `https://x/avatars/${hash ?? "default"}.png`,
				draw: async () => "a".repeat(64),
				edit: async () => "b".repeat(64),
			},
			runtime: () => runtime,
			pluginSelection: () => PLUGIN_SELECTION,
			confirmations: { approves: async (_p, reply) => reply.includes("yes") },
			scorer: { score: async () => script.scores },
			events: {
				turnStarted: (turn) => eventLog.push(`turnStarted ${turn.agent}`),
				turnEnded: (turn) =>
					eventLog.push(`turnEnded ${turn.agent} ${turn.result}`),
				changed: () => eventLog.push("changed"),
			},
			promptSections: () => script.prompt,
			pluginTools: () => script.tools,
			models: {
				defaults: {
					model: "claude-bridge/claude-opus-5-5",
					thinking: "medium",
				},
				usable: async () => USABLE,
			},
			schedules: {
				forChannel: async (channel) =>
					channel === discordKey("2000") ? [{ id: 7 }] : [],
				remove: async (id) => removedSchedules.push(id),
			},
			queue,
			startTyping: () => () => undefined,
			showStop: (channel) => {
				stops.push(`show ${channel}`);
				return () => stops.push(`hide ${channel}`);
			},
			workDir: "/tmp/agents/work",
			sharedPrompt: "Shared rules.",
			skills,
			logger: silentLogger(),
		});
		await team.start();
		Object.assign(fx, {
			store,
			channels,
			runtime,
			queue,
			team,
			skillStore,
			skills,
		});
		await settle();
	}, HOOK_TIMEOUT_MS);
}

export const opsGroup = () => {
	const group = store.group("ops");
	if (!group) throw new Error("no ops group");
	return group;
};

export const agentChannel = (name: string) =>
	discordKey(store.agent(name)?.channelId ?? "");

/** Runs `action` during the coordinator's turn, as a tool the model calls does. */
export async function duringTurn<T>(action: () => Promise<T>): Promise<T> {
	let outcome: { value: T } | { error: unknown } | undefined;
	runtime.during = async () => {
		// Only the first turn is the model's; the agent it creates starts one of its own.
		runtime.during = undefined;
		outcome = await action().then(
			(value) => ({ value }),
			(error: unknown) => ({ error }),
		);
	};
	await team.answerOwner(
		agentChannel("coordinator"),
		OWNER_SPEAKER,
		"go",
		"go",
		NO_ATTACHMENTS,
	);
	runtime.during = undefined;
	if (!outcome || "error" in outcome)
		throw (outcome as { error: unknown })?.error;
	return outcome.value;
}
