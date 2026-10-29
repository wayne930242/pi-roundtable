import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { CharacterInput, CharacterSpec } from "../characters/index.ts";
import type { Agent, AgentGroup } from "./agents/agent-rules.ts";
import type { AvatarMode } from "./agents/agent-tools.ts";
import type { TeamStatus } from "./agents/team-status.ts";
import type { ChannelContexts } from "./contract/channel-context.ts";
import type {
	BackgroundRunsAs,
	ScheduledOutcome,
} from "./contract/channels.ts";
import type { AgentRuntime } from "./contract/runtime.ts";
import { type ServiceKey, serviceKey } from "./contract/services.ts";
import type { ConversationRegistry } from "./conversations/conversation-registry.ts";
import type { PendingConfirmation } from "./domain/conversation.ts";
import type { HttpRoute } from "./http/listeners.ts";
import type { IdentityLinks } from "./identity/identity-links.ts";
import type { IdentityService } from "./identity/identity-service.ts";
import type { PersonProfiles } from "./identity/profiles.ts";
import type { ThinkingLevel, ThinkingSetting } from "./models.ts";
import type { ConversationModes } from "./modes/conversation-modes.ts";
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
	PromptDocuments,
	PromptVersion,
} from "./modules/prompts/prompt-documents.ts";
import type {
	PrecheckFinding,
	PrecheckRegistry,
} from "./modules/schedules/prechecks.ts";
import type {
	NewSchedule,
	Schedule,
	ScheduleChange,
} from "./modules/schedules/schedule-store.ts";
import type { SkillRegistry } from "./modules/skills/skill-contract.ts";
import type { AgentTurnScope, ChannelKey } from "./sessions.ts";
import type { Speaker } from "./speakers.ts";
import type { DispatchThreads } from "./threads/dispatch-threads.ts";

// The services the built-in plugins provide, and the ports they keep to. Each port is an
// interface, so an object with the same methods satisfies it without being one of the built-in
// classes; a plugin replaces a built-in by providing its own under the same key.

/**
 * Who the host serves: its principals, the identities linked to each, and their lasting roles.
 * Provided by the `identity` plugin, which every host registers first, so every plugin may read it.
 */
export const IDENTITY: ServiceKey<IdentityService> =
	serviceKey<IdentityService>("roundtable.identity");
/** How the core names a person (linked accounts' names and pictures, the chosen one, plugin sources); from the `identity` plugin. */
export const PROFILES: ServiceKey<PersonProfiles> = serviceKey<PersonProfiles>(
	"roundtable.profiles",
);
/**
 * Links a person's own account to their principal, which `IDENTITY` cannot. Provided by the
 * `identity` plugin only when the configuration lists providers in `access.selfLink`; read it with
 * `find` when your plugin works without it, and with `get` when it cannot.
 */
export const IDENTITY_LINKS: ServiceKey<IdentityLinks> =
	serviceKey<IdentityLinks>("roundtable.identity-links", {
		absent:
			'Self-linking is switched off. List the providers people may link in the configuration, such as access: { selfLink: { providers: ["discord"] } }.',
	});
/**
 * The runtime every conversation turn runs on: the agent server's, and each turn run through
 * `context.turns`. The `runtime` provider slot's when a plugin fills it, Pi's otherwise. Provided
 * by the `runtime` plugin, which every host registers, with or without the agent server.
 */
export const RUNTIME: ServiceKey<AgentRuntime> =
	serviceKey<AgentRuntime>("roundtable.runtime");
/**
 * The conversations run through `context.turns`: who each belongs to, its kind and visibility,
 * and when it was last active, recorded at its first turn. Provided by the `conversations` plugin.
 */
export const CONVERSATIONS: ServiceKey<ConversationRegistry> =
	serviceKey<ConversationRegistry>("roundtable.conversations");
/**
 * The per-conversation modes, yolo and long-running: read a conversation's with `peek`, set them
 * with `set` as an owner. They are stored per conversation key and survive a restart. Provided by
 * the `modes` plugin, which every host registers.
 */
export const MODES: ServiceKey<ConversationModes> =
	serviceKey<ConversationModes>("roundtable.modes");
/**
 * The dispatch threads of the host: a background dispatch (a coding task, a delegated task, a
 * message between agents) opens its thread beside the channel that started it, on the surface
 * that serves the channel, when that surface hosts threads (`ChatSurface.threads`). One instance
 * serves every surface; `DISCORD.threads` is the same instance. Provided by the `threads` plugin,
 * which every host registers.
 */
export const THREADS: ServiceKey<DispatchThreads> =
	serviceKey<DispatchThreads>("roundtable.threads");
/** The channel context of any surface, chosen by the message's channel key as `THREADS` is; provided by the `channel-context` plugin, which every host registers. */
export const CHANNEL_CONTEXT: ServiceKey<ChannelContexts> =
	serviceKey<ChannelContexts>("roundtable.channel-context");
/** The agent server: its team, its directory, the runtime that runs every agent turn. Provided by the agent-server plugin. */
export const AGENTS: ServiceKey<AgentServer> = serviceKey<AgentServer>(
	"roundtable.agents",
	{
		absent:
			"This host has no agent server: its configuration says agentServer: false, or it has neither discord nor agents. Remove agentServer: false and configure discord or agents, or drop the plugin that needs the agent server.",
	},
);
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
 * Worker sessions on the host's models: a fresh, unsaved Pi session that has only the tools a
 * plugin gives it. Provided by the `worker-sessions` plugin.
 */
export const WORKER_SESSIONS: ServiceKey<WorkerSessions> =
	serviceKey<WorkerSessions>("roundtable.worker-sessions");
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

/**
 * The prompt texts the owner edits in the app, each with a file version, an override and a
 * history. Provided by the built-in `prompts` plugin, which registers `shared` and `guest` (the
 * prompts of the agent server) and which every plugin set up after it may register more with; a
 * plugin reads a document's `text()` when it builds a prompt, so an override applies from the next
 * turn. Read it with `get`: the plugin is always on.
 */
export const PROMPTS: ServiceKey<PromptDocuments> =
	serviceKey<PromptDocuments>("roundtable.prompts");

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
	/** Where the agents' files are: the directories their shell and file tools run in. */
	workspace: AgentWorkspace;
}

/**
 * The directories the agents work in, as configured. Every agent shares them: the core has no
 * workspace per agent. Read-only data, so a plugin that shows or serves the files can find them;
 * the directories may not exist yet.
 */
export interface AgentWorkspace {
	/** The shell's shared working directory (`config.workDir`), where agents write without a hold. */
	readonly workDir: string;
	/** The agents' scratch dir (TMPDIR), when the host sets one; writes there are unheld too. */
	readonly scratchDir?: string;
}

/** Agent pictures: rendered from the agent's character, kept and served by content hash. */
export interface AvatarStudio {
	/** @deprecated Agents are no longer drawn, so this only tells whether an image provider is configured (it gates the generate_image hint); removed in 1.0. */
	readonly canDraw: boolean;
	/** The public URL of a picture, or of the default when there is none. */
	url(hash: string | undefined): string;
	/**
	 * Renders a character as the agent's picture (512 px PNG, modern light disc, idle face), stores
	 * it by content hash, and returns the hash; the same spec gives the same hash.
	 */
	render(spec: CharacterSpec): Promise<string>;
	/** @deprecated Agents are composed characters and no longer drawn; removed in 1.0. Draws a new picture from an avatar prompt; returns its hash. */
	draw(avatarPrompt: string): Promise<string>;
	/** @deprecated Removed in 1.0. Edits a stored picture by an instruction; returns the new picture's hash. */
	edit(hash: string | undefined, instruction: string): Promise<string>;
	/** @deprecated Removed in 1.0. A picture made from an agent's display name and name, for a host without an image provider; returns its hash. */
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

/** What an owner gives to create an agent: the fields of `agent_create`, with the settings `update` takes. */
export interface NewAgent {
	/** Permanent: lowercase letters, digits and dashes, 1 to 32. */
	name: string;
	displayName: string;
	prompt: string;
	/** Fields of its look; any left out come from the look its role suggests. */
	character?: CharacterInput;
	/** Its opening task; without it the agent only exists. */
	task?: string;
	/**
	 * The surface whose room the opening task runs in, so the person who asked sees it start
	 * there. Without it, or for a surface that hosts no rooms, the task runs where `agent_create`
	 * runs it: the agent's Discord channel, else its first room.
	 */
	openIn?: string;
	category?: string;
	/** Skills it carries; refused when the skills addon is off. */
	skills?: string[];
	model?: string;
	thinking?: string;
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
	/** The team's id: the Discord guild, or `"local"` on a host without Discord. */
	readonly guildId: string;
	/** Called when a turn starts or ends and when an agent or group changes. */
	onChange(listener: () => void): void;
	/** Every active agent and group, with what each is doing now. */
	status(): Promise<TeamStatus>;
	/**
	 * The agent or group that owns a channel of the agent server: a Discord channel, or a room
	 * (`<surface>:agent.<name>`, `<surface>:group.<name>`) on a surface that declares `agentRooms`.
	 */
	owns(channel: ChannelKey): "agent" | "group" | undefined;
	/**
	 * The name of the coordinator: the agent that answers in the entry channel, or, on a host without
	 * Discord, the one `coordinator` names (the first seed by default); undefined while none is active.
	 */
	coordinator(): string | undefined;
	/**
	 * Every key an agent or group is addressed by: its Discord channel when it has one, then its
	 * room on each surface with `agentRooms`; empty for an unknown name.
	 */
	roomsOf(name: string): ChannelKey[];
	/** The model and thinking setting of an agent's next run: its own, or the assistant's. */
	modelOf(name: string): { model: string; thinking: ThinkingSetting };
	/** The assistant's model and thinking setting, which agents without their own follow. */
	defaultModel(): { model: string; thinking: ThinkingSetting };
	/** Models an agent can be set to: every one the host runs, `current` first when given. */
	usableModels(current?: string): Promise<string[]>;
	/**
	 * An active agent's conversation, for reading its schedules: its room on the surface `near`
	 * (the asker's own conversation) is on when that surface hosts rooms, otherwise its Discord
	 * channel, otherwise its room on the first surface that hosts rooms. Throws ScheduleError for an
	 * unknown agent or one with none, as the schedule tools catch it.
	 */
	channelOf(name: string, near?: ChannelKey): ChannelKey;
	/** The channel the scope's turns run in: the group's in a group round, otherwise its own. */
	turnChannel(scope: AgentTurnScope): ChannelKey;
	/** Posts text under the caller's name in the channel of its turn. */
	postAs(caller: AgentTurnScope, text: string): Promise<void>;
	/** The assistant's own notice, posted in the coordinator's channel under its name. */
	announce(text: string): Promise<void>;
	/**
	 * Changes an agent's display name, prompt, model, or thinking level; a model must be one the
	 * host runs. `by` names who asks; a changed prompt is kept in the agent's prompt history under it.
	 */
	update(name: string, change: AgentChange, by?: string): Promise<string>;
	/** The changes of an agent's prompt, newest first: who made each, when, and the text it replaced. */
	promptHistory(name: string, limit?: number): Promise<PromptVersion[]>;
	/**
	 * Creates an agent for an owner, outside any agent turn: the checks, picture, channel and
	 * opening task of `agent_create`, with `speaker` as the one who asked. `model` and `thinking`
	 * take what `update` takes and are checked before anything is made; `task` is optional, and
	 * without it the agent waits in its room. Throws AgentError for a bad or taken name, an
	 * unusable model or an unknown skill.
	 */
	createAgent(speaker: Speaker, input: NewAgent): Promise<Agent>;
	/**
	 * Archives an agent or group like the `archive` tool: it stops answering, its schedules are
	 * cancelled, an agent leaves its groups, and its history is kept. `caller` is the agent that
	 * asks, which cannot archive itself; an owner's request has none. The coordinator cannot be
	 * archived.
	 */
	archive(caller: AgentTurnScope | undefined, name: string): Promise<string>;
	/**
	 * Returns an archived agent or group to the active ones. An agent rejoins no group; a group
	 * needs all its members active. Throws AgentError for an unknown or active name.
	 */
	restore(name: string): Promise<string>;
	/**
	 * Deletes an archived agent or group for good and frees its name. Throws AgentError for an
	 * unknown name, for an active one (archive it first), and for an agent the host's seeds name,
	 * which the next start would seed again. `cleanup` is a surface's own part of the delete (what
	 * it kept under the name): it runs once the checks have passed and before anything is deleted,
	 * and one that throws leaves the agent or group in place, so the delete can be tried again.
	 */
	remove(name: string, cleanup?: () => Promise<void>): Promise<string>;
	/** Creates a group of 2 to 6 agents; the host is the first member unless given. */
	createGroup(input: {
		name: string;
		displayName: string;
		members: string[];
		host?: string;
		category?: string;
	}): Promise<string>;
	/** Changes a group's display name, members (all of them) or host. */
	updateGroup(
		name: string,
		change: { displayName?: string; members?: string[]; host?: string },
	): Promise<string>;
	/**
	 * Changes an agent's look: `input` is resolved over its current character (a new class keeps
	 * its colors unless the input gives a palette or colors), rendered, and stored with the new
	 * picture. Throws AgentError naming the field of a bad input, and for an unknown or archived agent.
	 */
	dress(name: string, input: CharacterInput): Promise<Agent>;
	/**
	 * @deprecated Agents are composed characters and no longer drawn; use `dress`. Removed in 1.0.
	 * Draws and stores a new picture for an agent; it still needs an image provider.
	 */
	redrawAvatar(name: string, mode: AvatarMode, text?: string): Promise<Agent>;
}

/** Scheduled turns, stored. A one-time schedule is deleted once it fires. */
export interface ScheduleStore {
	create(schedule: NewSchedule): Promise<Schedule>;
	/**
	 * Creates a schedule unless its creator already has `limit.max` of its target's schedules,
	 * counting those whose creator id is one of `limit.creators`; resolves the count reached instead.
	 * Two calls for one creator never count at once, so creates at once in many conversations stay
	 * within the limit.
	 */
	createWithin(
		schedule: NewSchedule,
		limit: { creators: readonly string[]; max: number },
	): Promise<{ created: Schedule } | { reached: number }>;
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
	/**
	 * Who a due schedule's turn would run as now, checked as the turn is: asked before its
	 * precheck, which runs only for a creator who may run the turn, at the tier it would run at.
	 * Throws when the identity service cannot tell.
	 */
	runsAs(schedule: Schedule): Promise<BackgroundRunsAs>;
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

/** One task for a worker session. */
export interface WorkerSessionRequest {
	/** What the worker is asked to do, as its one prompt. */
	task: string;
	/** Aborting it stops the worker; `run` then rejects. */
	signal: AbortSignal;
	/** Appended to the worker's system prompt: its role, its rules, and any instructions it should follow. */
	prompt: string;
	/** Extensions that register the worker's tools with `pi.registerTool`. */
	extensions: readonly ExtensionFactory[];
	/** The only tools active in the session. The session has no built-in tool, skill, context file or other extension. */
	toolNames: readonly string[];
	/** `<provider>/<id>`; default: the host's delegation model. */
	model?: string;
	/** Default: the host's delegation thinking level. */
	thinking?: ThinkingLevel;
	/** Why an aborted run stopped, as the rejection's message; default "the worker ran out of time". */
	aborted?: string;
}

/**
 * Runs one task in a fresh, unsaved Pi session on the host's model login and returns the worker's
 * final answer. The session is disposed of either way. It has no access to the conversation, the
 * owner's memory or the agents' tools: it can do only what `toolNames` lets it, and the tools a
 * plugin registers for it are that plugin's to bound.
 */
export interface WorkerSessions {
	/** The model and thinking level a request without its own uses: the host's `delegation` settings. */
	readonly delegation: {
		readonly model: string;
		readonly thinking: ThinkingLevel;
	};
	/** Rejects with an `AgentRunError` when the worker ends without an answer. */
	run(request: WorkerSessionRequest): Promise<string>;
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

export type { SkillRegistry } from "./modules/skills/skill-contract.ts";
