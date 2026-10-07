import type { Agent, AgentGroup } from "./agents/agent-rules.ts";
import type { AvatarMode } from "./agents/agent-tools.ts";
import type { TeamStatus } from "./agents/team-status.ts";
import type { ScheduledOutcome } from "./contract/channels.ts";
import type { AgentRuntime } from "./contract/runtime.ts";
import { type ServiceKey, serviceKey } from "./contract/services.ts";
import type { PendingConfirmation } from "./domain/conversation.ts";
import type { HttpRoute } from "./http/listeners.ts";
import type { ThinkingSetting } from "./models.ts";
import type {
	DelegationJob,
	DelegationOutcome,
} from "./modules/delegation/delegator.ts";
import type {
	Memory,
	MemoryKind,
	PromptMemory,
} from "./modules/memory/owner-memory-store.ts";
import type {
	PrecheckFinding,
	PrecheckRegistry,
} from "./modules/schedules/prechecks.ts";
import type {
	NewSchedule,
	Schedule,
	ScheduleChange,
} from "./modules/schedules/schedule-store.ts";
import type {
	SkillCatalogEntry,
	SkillSet,
} from "./modules/skills/skill-rules.ts";
import type { AgentTurnScope, ChannelKey } from "./sessions.ts";

// The services the built-in plugins provide, and the ports they keep to. Each port is an
// interface, so an object with the same methods satisfies it without being one of the built-in
// classes; a plugin replaces a built-in by providing its own under the same key.

/**
 * The runtime every conversation turn runs on: the agent server's, and each turn run through
 * `context.turns`. The `runtime` provider slot's when a plugin fills it, Pi's otherwise. Provided
 * by the `runtime` plugin, which every host registers, with or without the agent server.
 */
export const RUNTIME: ServiceKey<AgentRuntime> =
	serviceKey<AgentRuntime>("roundtable.runtime");
/** The agent server: its team, its directory, the runtime that runs every agent turn. Provided by the agent-server plugin. */
export const AGENTS: ServiceKey<AgentServer> =
	serviceKey<AgentServer>("roundtable.agents");
/** Scheduled turns, stored. Provided by the `schedule-store` plugin. */
export const SCHEDULES: ServiceKey<ScheduleStore> = serviceKey<ScheduleStore>(
	"roundtable.schedules",
);
/**
 * The host's named prechecks, which a schedule may run before its turn to decide whether the
 * agent is woken at all. Provided by the `prechecks` plugin; register yours during setup:
 * `services.get(PRECHECKS).register({ name, description, run })`.
 */
export const PRECHECKS: ServiceKey<PrecheckRegistry> =
	serviceKey<PrecheckRegistry>("roundtable.prechecks");
/** Turns nobody wrote: a due schedule's, a delegated task's report, a logged error's. Provided by the modules plugin. */
export const BACKGROUND_TURNS: ServiceKey<BackgroundTurns> =
	serviceKey<BackgroundTurns>("roundtable.background-turns");
/** Tasks run in the background, each reporting back in its channel. Provided by the modules plugin. */
export const DELEGATION: ServiceKey<Delegator> = serviceKey<Delegator>(
	"roundtable.delegation",
);
/**
 * The remembered facts of each speaker. Provided by the `memory` plugin, an addon: read it with
 * `find` when your plugin works without memory, and with `get` when it cannot.
 */
export const MEMORY: ServiceKey<MemoryStore> = serviceKey<MemoryStore>(
	"roundtable.memory",
	{
		absent:
			"The memory addon is switched off (config memory: false). Switch it on, or provide the service from a plugin of your own.",
	},
);
/**
 * The skills agents carry. Provided by the `skills` plugin, an addon: read it with `find` when
 * your plugin works without skills, and with `get` when it cannot.
 */
export const SKILLS: ServiceKey<SkillRegistry> = serviceKey<SkillRegistry>(
	"roundtable.skills",
	{
		absent:
			"The skills addon is switched off (config skills: false). Switch it on, or provide the service from a plugin of your own.",
	},
);

/** What the agent server builds, for the plugins set up after it. */
export interface AgentServer {
	team: AgentTeam;
	/** Read-only lookups of agents and groups; edits go through the team. */
	directory: AgentDirectory;
	/** The runtime every agent-server turn runs on: the same one `RUNTIME` provides. */
	runtime: AgentRuntime;
	/** Decides whether the owner's reply approves the actions the assistant held for them. */
	approvals: {
		approves(pending: PendingConfirmation, reply: string): Promise<boolean>;
	};
	/** Agents' pictures. */
	avatars: AvatarStudio;
}

/** Agent pictures: drawn by an image provider, or made from the agent's name, kept and served by content hash. */
export interface AvatarStudio {
	/** Whether an image provider is configured; without one, only `fallback` makes pictures. */
	readonly canDraw: boolean;
	/** The public URL of a picture, or of the default when there is none. */
	url(hash: string | undefined): string;
	/** Draws a new picture from an avatar prompt; returns its hash. */
	draw(avatarPrompt: string): Promise<string>;
	/** Edits a stored picture by an instruction; returns the new picture's hash. */
	edit(hash: string | undefined, instruction: string): Promise<string>;
	/** A picture made from an agent's display name and name, for a host without an image provider; returns its hash. */
	fallback(displayName: string, name: string): Promise<string>;
	/** The pictures, public on the named listener. */
	route(listener: string): HttpRoute;
	/** Serves `/avatars/<hash>.png`; undefined for any other path. */
	serve(pathname: string): Response | undefined;
}

/** The read half of the agent store: every inbound message asks, and only this process changes them. */
export interface AgentDirectory {
	agents(): Agent[];
	agent(name: string): Agent | undefined;
	/** The agent, or throws AgentError when it is unknown or archived. */
	activeAgent(name: string): Agent;
	agentByChannel(channelId: string): Agent | undefined;
	groups(): AgentGroup[];
	group(name: string): AgentGroup | undefined;
	groupByChannel(channelId: string): AgentGroup | undefined;
}

/** What an agent's settings may change, as `update` takes it. */
export interface AgentChange {
	displayName?: string;
	prompt?: string;
	model?: string;
	thinking?: string;
}

/** The agent team as plugins use it: who is in it, what model they run, and their channels. */
export interface AgentTeam {
	readonly guildId: string;
	/** Called when a turn starts or ends and when an agent or group changes. */
	onChange(listener: () => void): void;
	/** Every active agent and group, with what each is doing now. */
	status(): Promise<TeamStatus>;
	/** The agent or group that owns a channel of the agent server. */
	owns(channel: ChannelKey): "agent" | "group" | undefined;
	/** The model and thinking setting of an agent's next run: its own, or the assistant's. */
	modelOf(name: string): { model: string; thinking: ThinkingSetting };
	/** The assistant's model and thinking setting, which agents without their own follow. */
	defaultModel(): { model: string; thinking: ThinkingSetting };
	/** Models an agent can be set to: every one the host runs, `current` first when given. */
	usableModels(current?: string): Promise<string[]>;
	/** An active agent's channel; throws ScheduleError for an unknown agent, as the schedule tools catch it. */
	channelOf(name: string): ChannelKey;
	/** The channel the scope's turns run in: the group's in a group round, otherwise its own. */
	turnChannel(scope: AgentTurnScope): ChannelKey;
	/** Posts text under the caller's name in the channel of its turn. */
	postAs(caller: AgentTurnScope, text: string): Promise<void>;
	/** The assistant's own notice, posted in the coordinator's channel under its name. */
	announce(text: string): Promise<void>;
	/** Changes an agent's display name, prompt, model, or thinking level; a model must be one the host runs. */
	update(name: string, change: AgentChange): Promise<string>;
	/** Draws and stores a new picture for an agent. */
	redrawAvatar(name: string, mode: AvatarMode, text?: string): Promise<Agent>;
}

/** Scheduled turns, stored. A one-time schedule is deleted once it fires. */
export interface ScheduleStore {
	create(schedule: NewSchedule): Promise<Schedule>;
	get(id: number): Promise<Schedule | undefined>;
	forChannel(channel: ChannelKey): Promise<Schedule[]>;
	all(): Promise<Schedule[]>;
	/** Applies a change to one of the channel's schedules; undefined when it has no such schedule. */
	update(
		channel: ChannelKey,
		id: number,
		change: ScheduleChange,
	): Promise<Schedule | undefined>;
	/** Deletes a schedule, only from the given channel when one is given. */
	remove(id: number, channel?: ChannelKey): Promise<Schedule | undefined>;
	due(now: Date): Promise<Schedule[]>;
	/** Takes a due schedule before it runs: moves it to its next run, or deletes it when there is none; false when another claim won. */
	claim(
		schedule: Schedule,
		next: Date | undefined,
		now: Date,
	): Promise<boolean>;
	/** Records how a run ended. */
	recordStatus(id: number, status: string): Promise<void>;
}

/** Turns nobody wrote, each answered in its channel by the claim that owns it. */
export interface BackgroundTurns {
	/** A due schedule's turn, run as its creator's; with what its precheck found, when it has one. */
	runScheduled(
		schedule: Schedule,
		firedAt: Date,
		finding?: PrecheckFinding,
	): Promise<ScheduledOutcome>;
	/** A delegated task's report, answered in its channel under the same rules as a schedule. */
	runDelegated(job: DelegationJob, result: DelegationOutcome): Promise<void>;
	/** The process's own logged error, reported to an agent in its channel as a report turn. */
	runErrorReport(channel: ChannelKey, text: string): Promise<ScheduledOutcome>;
}

/** What a delegated task is asked with: its job, before the delegator numbers and times it. */
export type DelegationRequest = Omit<
	DelegationJob,
	"id" | "startedAt" | "thread"
>;

/** Tasks run in the background, each handing its result back to its channel. Jobs live in memory. */
export interface Delegator {
	/** Starts a job and returns at once; throws DelegationError on bad input or a full channel. */
	start(request: DelegationRequest): DelegationJob;
	/** The channel of each job still running, one entry per job. */
	runningChannels(): ChannelKey[];
	/** Resolves once every started job has reported. */
	idle(): Promise<void>;
}

/** Remembered facts, each speaker's own; every agent shares the memory of whoever is speaking. */
export interface MemoryStore {
	/** One speaker's memory; it never reads or changes another's. */
	forSpeaker(speakerId: string): SpeakerMemory;
}

/** One speaker's remembered facts. */
export interface SpeakerMemory {
	list(): Promise<Memory[]>;
	/** What every turn carries: all core facts, and events that have not passed yet. */
	forPrompt(today: string): Promise<PromptMemory>;
	add(fact: string, kind?: MemoryKind, eventDate?: string): Promise<Memory>;
	/** Memories containing any query term, most terms matched first, then newest first. */
	search(query: string, limit?: number): Promise<Memory[]>;
	/** Replaces one memory's text, kind, and date; undefined when the id is unknown. */
	update(
		id: number,
		change: { fact: string; kind: MemoryKind; eventDate?: string },
	): Promise<Memory | undefined>;
	/** Deletes one memory; false when the id is unknown. */
	removeById(id: number): Promise<boolean>;
	/** Deletes every memory containing the text; returns the removed facts. */
	remove(text: string): Promise<string[]>;
}

/** The skills agents carry: built in, linked from repositories, or written by an agent. */
export interface SkillRegistry {
	/** The built-in skills plus the named registered ones, resolved to their files. */
	resolve(names: readonly string[]): SkillSet;
	/** What an agent carries, built-in skills included. */
	carried(agent: string): SkillSet;
	/** The registered skills an agent carries, as the dashboard lists them. */
	carriedNames(agent: string): string[];
	/** An agent's skills as `agent_get` shows them. */
	describeCarried(agent: string): string;
	/** Every skill, built-in ones first. */
	catalog(): SkillCatalogEntry[];
	/** Every skill, or those of a group or matching a query, as the `skill_list` tool shows them. */
	list(filter?: { group?: string; query?: string }): string;
	/** The skills linked from a managed repository. */
	linkedFrom(repo: string): string[];
	/** Throws AgentError when a name is not registered; built-in names are carried already. */
	checkRegistered(names: readonly string[]): void;
	/** Links the skill at a repository path, or every child folder with a SKILL.md. */
	link(repo: string, path: string): Promise<string>;
	/** Adds and removes an agent's registered skills together, or changes nothing; returns what it carries after. */
	attach(
		agent: string,
		add: readonly string[],
		remove: readonly string[],
	): Promise<string[]>;
}
