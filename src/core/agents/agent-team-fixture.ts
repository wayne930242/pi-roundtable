import { beforeEach } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQL } from "bun";
import { discordIdOf, discordKey } from "../contract/discord-key.ts";
import type { PlaceProvider } from "../contract/places.ts";
import type { ChatSurface } from "../contract/surface.ts";
import { NO_ATTACHMENTS } from "../domain/attachment.ts";
import type {
	ChannelKey,
	OutboundReply,
	PostAuthor,
} from "../domain/conversation.ts";
import type { RoundProgress } from "../domain/round.ts";
import type { IdentityService } from "../identity/identity-port.ts";
import { silentLogger } from "../kernel/log.ts";
import { StoredSkillRegistry as SkillRegistry } from "../modules/skills/skill-registry.ts";
import { SkillStore } from "../modules/skills/skill-store.ts";
import type { PromptSection } from "../plugin-api/plugin.ts";
import { type ChannelQueue, channelQueue } from "../routing/channel-queue.ts";
import { toolTiers } from "../runtime/tool-tiers.ts";
import {
	openTestStore,
	TEST_GUILD,
	type TestStore,
	testDatabaseUrl,
} from "../testing/database.ts";
import { useTestLocale } from "../testing/locale.ts";
import { OWNER_SPEAKER, TEST_OWNER } from "../testing/owner.ts";
import {
	discordTestChannelOps,
	discordTestPlaces,
	testPlacePort,
} from "../testing/team-places.ts";
import type { Agent } from "./agent-rules.ts";
import { PgAgentStore as AgentStore } from "./agent-store.ts";
import {
	AgentServerTeam as AgentTeam,
	type AgentTeamOptions,
} from "./agent-team.ts";
import { seeds } from "./agent-team-seeds.ts";
import { TeamPlaces } from "./team-places.ts";

export const ENTRY = "1000";
export const USABLE = [
	"claude-bridge/claude-opus-5-5",
	"openai-codex/gpt-6-sol",
];

/**
 * The surfaces a team replies through in rooms. `rooms` names the surfaces that host rooms and
 * starts empty, so the Discord suites run as if no surface did; a room suite sets it.
 */
class FakeSurfaces {
	rooms: string[] = [];
	replies: { channel: ChannelKey; reply: OutboundReply }[] = [];
	/** Interim posts as `channel name/agent: text`, edits included. */
	interims: string[] = [];
	/** What each round told the surface, in order. */
	rounds: { channel: ChannelKey; round: RoundProgress }[] = [];
	async groupRound(channel: ChannelKey, round: RoundProgress) {
		// A surface hears of the rounds of its own rooms only; Discord's channels are not any room's.
		if (this.rooms.includes(channel.slice(0, channel.indexOf(":"))))
			this.rounds.push({ channel, round });
	}
	roomSurfaces() {
		return this.rooms;
	}
	/** A room's surface carries no files, as a surface that does not declare `supportsFiles`. */
	of(_channel: ChannelKey): ChatSurface | undefined {
		return undefined;
	}
	async sendReply(channel: ChannelKey, reply: OutboundReply) {
		this.replies.push({ channel, reply });
	}
	interim(channel: ChannelKey, as?: PostAuthor) {
		if (!as) return undefined;
		return {
			post: async (text: string) => {
				this.interims.push(`${channel} ${as.name}/${as.agent}: ${text}`);
				return {
					edit: async (change: string) => {
						this.interims.push(
							`${channel} ${as.name}/${as.agent}: edit ${change}`,
						);
					},
				};
			},
		};
	}
	/** What the room was told, as `agent: text`. */
	texts(channel: ChannelKey) {
		return this.replies.flatMap((r) =>
			r.channel === channel
				? [`${r.reply.author?.agent}: ${r.reply.chunks.join("")}`]
				: [],
		);
	}
}

export { FakeChannels } from "../testing/fake-agent-channels.ts";
export { FakeRuntime } from "./agent-team-fake-runtime.ts";

import { FakeChannels } from "../testing/fake-agent-channels.ts";

import { FakeRuntime } from "./agent-team-fake-runtime.ts";

// CI runs the setup below about ten times slower than a laptop, and bun's 5 s hook limit
// left a timed-out hook running while the next test dropped its tables.
export const HOOK_TIMEOUT_MS = 30_000;

// Runs against a real PostgreSQL, only when ROUNDTABLE_TEST_DATABASE_URL is set.
let store: TestStore<AgentStore>;
let channels: FakeChannels;
let surfaces: FakeSurfaces;
let runtime: FakeRuntime;
export interface TeamFixture {
	/** Where the team's agents are, as the host's place providers give it: Discord's (unless `local`), a room on each of `surfaces.rooms`, and `stored`. */
	places: TeamPlaces;
	/** The stored place providers a test adds to the host's, read at each call; empty at the start of each test. */
	stored: PlaceProvider[];
	store: TestStore<AgentStore>;
	channels: FakeChannels;
	surfaces: FakeSurfaces;
	runtime: FakeRuntime;
	queue: ChannelQueue;
	team: AgentTeam;
	skillStore: TestStore<SkillStore>;
	skills: SkillRegistry;
}

/** The tool tiers the team reads; `deploy` is an admin's tool, so an admin may approve it. */
const FIXTURE_TIERS = toolTiers();
FIXTURE_TIERS.declare("test", { deploy: "admin" });

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
	withheld: string[];
	/** The prompt every agent's starts with; read before each turn, so a test may change it. */
	shared: string;
	/** The one a speaker other than the owner gets instead; empty falls back to `shared`. */
	guest: string;
} = {
	scores: undefined,
	prompt: [],
	tools: [],
	withheld: [],
	shared: "Shared rules.",
	guest: "",
};
let queue: ChannelQueue;
let team: AgentTeam;
let build: () => AgentTeam;
let skillStore: TestStore<SkillStore>;
let skills: SkillRegistry;
let places: TeamPlaces;
const stored: PlaceProvider[] = [];
/** The listeners the stand-in Discord was given for a deleted channel; `deleteChannel` calls them, as the server does. */
const removedListeners: ((channelId: string) => void)[] = [];
export const removedSchedules: number[] = [];
export const stops: string[] = [];
/** The events the team reported, in order, as `turnStarted infra`, `turnEnded infra ok`, or `changed`. */
export const eventLog: string[] = [];

/** What a plugin adds to every agent's tools: a tool of its own and a group of another server's. */
const PLUGIN_SELECTION = { tools: ["memory_add"], groups: ["workspace"] };

/** Whether an action of the agent waits for the owner, in any of its places. */
function holdsAction(agent: Agent): boolean {
	return places
		.keysOf(agent.name)
		.some((key) => runtime.held.has(places.scopeOf(agent, key).session));
}

/**
 * Waits until every queued channel task has settled, every active agent has its avatar, which
 * startup draws in the background, and every temp knight's stamp has caught up with its work (the
 * stamp is written after the turn starts or ends, off the queue): finished, or still working
 * while an action of it is held. A fixed sleep was too short on a slow runner.
 */
export async function settle(): Promise<void> {
	const deadline = Date.now() + 10_000;
	const quiet = () =>
		queue.busy().length === 0 &&
		store.agents().every((a) => a.status !== "active" || a.avatarHash) &&
		store
			.agents()
			.every(
				(a) =>
					!a.parent ||
					a.status !== "active" ||
					(a.finishedAt === undefined) === holdsAction(a),
			);
	while (!quiet() && Date.now() < deadline) await Bun.sleep(5);
	// Work the last task queued is still finishing.
	await Bun.sleep(20);
}

/**
 * Registers the fixture's per-test setup in the describe it is called from. With `local`, the team
 * runs as on a host without Discord: no channels and no entry channel, the coordinator named by
 * the configuration, and the rooms of surface `app`.
 */
export function useTeamFixture(
	options: {
		local?: boolean;
		/** The studio the team renders with, called each test; the default fakes pictures. */
		studio?: () => AgentTeamOptions["studio"];
		/** The temp knights' limits the team is built with; left out, the defaults. */
		helpers?: AgentTeamOptions["helpers"];
	} = {},
): void {
	const { local = false } = options;
	beforeEach(async () => {
		// The expected texts are the neutral English catalog's.
		useTestLocale();
		await store?.close();
		await skillStore?.close();
		const admin = new SQL(testDatabaseUrl);
		for (const table of [
			"agent_places",
			"agents",
			"agent_groups",
			"agent_group_messages",
			"agent_group_cursors",
			"agent_outbox",
			"agent_latest_conversation",
			"prompt_history",
			"skills",
			"skill_versions",
			"skill_groups",
			"agent_skills",
			"helper_presets",
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
		surfaces = new FakeSurfaces();
		if (local) surfaces.rooms = ["app"];
		runtime = new FakeRuntime();
		stored.length = 0;
		removedListeners.length = 0;
		// The host's providers: Discord's channels with a guild, a room on each surface that hosts them, and a test's own.
		places = new TeamPlaces(
			store,
			store.places,
			testPlacePort({
				rooms: () => surfaces.rooms,
				stored: () => [
					...(local
						? []
						: [
								discordTestPlaces(TEST_GUILD, {
									channels,
									server: {
										gone: (id) => channels.deleted.has(id),
										foreign: (id) => channels.foreign.has(id),
										fails: (id) => channels.failing.has(id),
									},
									onRemoved: (listener) => removedListeners.push(listener),
									nameOf: (id) => store.placeOwner(discordKey(id))?.name,
								}),
							]),
					...stored,
				],
				// SAFETY: only a derived provider's post reads it, which the team does not use yet.
				surfaces: surfaces as never,
			}),
		);
		store.readPlacesWith(places);
		script.scores = undefined;
		script.prompt = [];
		script.tools = [];
		script.withheld = [];
		script.shared = "Shared rules.";
		script.guest = "";
		queue = channelQueue();
		removedSchedules.length = 0;
		identity.current = undefined;
		stops.length = 0;
		eventLog.length = 0;
		build = () =>
			new AgentTeam({
				owner: TEST_OWNER,
				toolTiers: FIXTURE_TIERS,
				principals: () => identity.current,
				shellUser: "mcops",
				places,
				teamId: local ? "local" : "1",
				...(local
					? { coordinator: "coordinator" }
					: { entryChannel: discordKey(ENTRY) }),
				seeds: () => seeds(local ? undefined : ENTRY),
				store,
				surfaces,
				studio: options.studio?.() ?? {
					url: (hash) => `https://x/avatars/${hash ?? "default"}.png`,
					render: async (spec) =>
						new Bun.CryptoHasher("sha256")
							.update(JSON.stringify(spec))
							.digest("hex"),
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
				pluginWithheldFromHelpers: () => script.withheld,
				models: {
					defaults: {
						model: "claude-bridge/claude-opus-5-5",
						thinking: "medium",
					},
					usable: async () => USABLE,
				},
				schedules: {
					forChannel: async (channel) =>
						channel === discordKey("2000")
							? [{ id: 7 }]
							: channel === "app:agent.doctor"
								? [{ id: 8 }]
								: [],
					remove: async (id) => removedSchedules.push(id),
				},
				queue,
				startTyping: () => () => undefined,
				showStop: (channel) => {
					stops.push(`show ${channel}`);
					return () => stops.push(`hide ${channel}`);
				},
				workDir: "/tmp/agents/work",
				sharedPrompt: () => script.shared,
				guestPrompt: () => script.guest,
				skills,
				...(options.helpers !== undefined ? { helpers: options.helpers } : {}),
				// Discord's side of the deprecated `arrange` and `read`, as the host hands it with a guild.
				...(local
					? {}
					: {
							formerChannelOps: () =>
								discordTestChannelOps(channels, {
									agent: (name) => store.agent(name),
									group: (name) => store.group(name),
									ownerOf: (id) => store.placeOwner(discordKey(id))?.name,
									channelOf: (name) => {
										const key = places.placeOn(name, "discord");
										return key === undefined ? undefined : discordIdOf(key);
									},
								}),
						}),
				logger: silentLogger(),
			});
		team = build();
		await team.start();
		Object.assign(fx, {
			places,
			stored,
			store,
			channels,
			surfaces,
			runtime,
			queue,
			team,
			skillStore,
			skills,
		});
		await settle();
	}, HOOK_TIMEOUT_MS);
}

/** The server deletes a channel and tells the listeners the team registered. */
export function deleteChannel(channelId: string): void {
	channels.deleted.add(channelId);
	for (const listener of removedListeners) listener(channelId);
}

/** Starts the team again over the same database, as a restarted host: a new queue, runtime and team. */
/** The identity service the team's replay asks; none until a test sets one. */
export const identity: { current?: Pick<IdentityService, "speakerFor"> } = {};

export async function restart(): Promise<void> {
	queue = channelQueue();
	runtime = new FakeRuntime();
	team = build();
	await team.start();
	Object.assign(fx, { queue, runtime, team });
	await settle();
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
