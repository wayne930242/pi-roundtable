import type { SQL } from "bun";
import type { AgentSeed } from "./agents/agent-store.ts";
import type {
	ChannelClaim,
	ConversationPort,
	QueuePort,
} from "./contract/channels.ts";
import type { InteractionContribution } from "./contract/discord.ts";
import type { Providers } from "./contract/providers.ts";
import type { Migration } from "./db/migrations.ts";
import type { ToolContribution } from "./define.ts";
import type { HoldCheck, HoldRule } from "./holds.ts";
import type { HttpRoute } from "./http/listeners.ts";
import type { Logger } from "./log.ts";
import type { ComposedInteractions } from "./registry/interactions.ts";
import type { CoreAccess, CoreRegistry } from "./services.ts";
import type {
	AgentTurnScope,
	ChannelKey,
	SessionPlan,
	SessionTool,
	ToolSelection,
} from "./sessions.ts";
import type { Speaker } from "./speakers.ts";
import type { ToolTiers } from "./tool-tiers.ts";

/**
 * A long-lived part of a plugin. Services start in registration order and stop in reverse,
 * so one registered earlier outlives those registered after it.
 */
export interface Service {
	name: string;
	start?(): Promise<void> | void;
	stop?(): Promise<void> | void;
	/** Work still running or waiting, one entry each; the shutdown drain waits until every list is empty. */
	busy?(): string[];
}

/** How the agent server's startup ended. */
export type AgentServerOutcome = "ready" | "failed";

/** One agent turn, as a handler hears of it. */
export interface TurnEvent {
	agent: string;
	/** The channel the turn runs in: the agent's own, or a group's. */
	channel: ChannelKey;
	/** Who the turn is for. */
	speaker: Speaker | undefined;
	/** The group, for a member's turn in one. */
	group?: string;
}

/** How a turn ended. */
export interface TurnEndEvent extends TurnEvent {
	result: "ok" | "failed" | "stopped";
}

/** What a plugin may react to; a handler that throws is logged and never stops the others. */
export interface EventHandlers {
	/** Once the agent server has started, or failed to; the rest of the process runs either way. */
	agentServer?(outcome: AgentServerOutcome): Promise<void> | void;
	/** An agent's turn began. */
	turnStarted?(turn: TurnEvent): Promise<void> | void;
	/** An agent's turn ended, however it ended. */
	turnEnded?(turn: TurnEndEvent): Promise<void> | void;
	/** The team changed: an agent or group was created, edited, arranged, archived, or started over. */
	changed?(): Promise<void> | void;
	/** The shutdown drain ended, before any service stops; `left` is the work it gave up on. */
	shutdown?(left: readonly string[]): Promise<void> | void;
}

/** What the core reports to the plugins' handlers. */
export interface EventSink {
	turnStarted(turn: TurnEvent): void;
	turnEnded(turn: TurnEndEvent): void;
	changed(): void;
}

/** What a prompt section is built for: one agent's turn. */
export interface PromptTurn {
	agent: { name: string; displayName: string };
	/** Who the turn is for; undefined between turns. */
	speaker: Speaker | undefined;
	scope: AgentTurnScope;
}

/** A section a plugin adds to every agent turn's system prompt. */
export interface PromptSection {
	name: string;
	/** The section's text for the turn, or undefined to add nothing. */
	build(turn: PromptTurn): string | undefined;
}

/** What a plugin adds to the process; a plugin that adds nothing is refused. */
export interface Contribution {
	services?: Service[];
	events?: EventHandlers;
	/** Modules that answer Discord interactions, with their subcommands under the root command. */
	interactions?: InteractionContribution[];
	/** Handlers on the host's HTTP listeners. */
	http?: HttpRoute[];
	/** Rules deciding which tool calls wait for the owner's approval, asked in contribution order. */
	holdRules?: readonly HoldRule[];
	/** Pi packages every conversation session loads, in contribution order. */
	piPackages?: readonly string[];
	/** Extensions of every conversation session, placed by phase around the core's own. */
	sessionTools?: readonly SessionTool[];
	/** The channels whose conversations the plugin owns. */
	channels?: readonly ChannelClaim[];
	/** Lines the agent server's dashboard shows under its title, such as links, in contribution order. */
	dashboard?: readonly string[];
	/** Tools the plugin adds, each with the lowest tier that may use it; built with `defineTool`. */
	tools?: readonly ToolContribution[];
	/** Agents created on the first start; one already stored is never overwritten. */
	seeds?: readonly AgentSeed[];
	/** Sections added to every agent turn's system prompt, in contribution order. */
	prompt?: readonly PromptSection[];
	/**
	 * Tools and tool groups every agent turn carries besides its own, read before each turn so a
	 * set that changes while the process runs, such as connected servers, stays current.
	 */
	agentSelection?: () => ToolSelection;
}

/** The parts a contribution may have; any other key is a mistake the host names. */
export const CONTRIBUTION_KEYS = [
	"services",
	"events",
	"interactions",
	"http",
	"holdRules",
	"piPackages",
	"sessionTools",
	"channels",
	"dashboard",
	"tools",
	"seeds",
	"prompt",
	"agentSelection",
] as const satisfies readonly (keyof Contribution)[];

/** The session parts the host links from every plugin's contributions once all are set up. */
export interface LinkedSessions {
	/** Every contributed hold rule, asked in contribution order until one describes the call. */
	holds: HoldCheck;
	/** Every contributed Pi package in contribution order, each once. */
	piPackages: readonly string[];
	plan: SessionPlan;
	/** The agents every plugin seeds, in contribution order. */
	seeds: readonly AgentSeed[];
	/** Every plugin's prompt sections, in contribution order. */
	prompt: readonly PromptSection[];
	/** The tools plugins defined for agents, by name. */
	agentTools: readonly string[];
	/** Every plugin's agent selection merged, read before each agent turn. */
	agentSelection(): ToolSelection;
}

/** What the host gives every plugin. */
export interface PluginContext {
	logger: Logger;
	/** The linked session parts; throws NotLinkedError when called during setup. */
	sessions(): LinkedSessions;
	/** The one channel queue every conversation and channel operation shares. */
	queue: QueuePort;
	/** What each tool needs; plugin tools are added when the host links, so ask at use time. */
	toolTiers: ToolTiers;
	/** Where the core reports turns and team changes, for every plugin's handlers. */
	events: EventSink;
	/** The claimed channels' conversations; calls during setup throw NotLinkedError. */
	conversations: ConversationPort;
	/** The host's one connection pool, migrated before any setup; throws PluginError without a database. */
	database(): SQL;
	/** What the built-in plugins provide, for the plugins registered after them; throws PluginError until provided. */
	core: CoreAccess & { provide: CoreRegistry["provide"] };
	/** Each provider slot, from the plugin that fills it or the core's default. */
	providers: Providers;
	/** Every plugin's dashboard lines, in contribution order; throws NotLinkedError during setup. */
	dashboard(): readonly string[];
}

export interface RoundtablePlugin {
	name: string;
	/** The plugin's tables; the host runs every plugin's, in registration order, before any setup. */
	migrations?: readonly Migration[];
	/** The provider slots the plugin fills, resolved before any setup; two plugins cannot fill one slot. */
	providers?: Partial<Providers>;
	setup(context: PluginContext): Promise<Contribution> | Contribution;
	/**
	 * Runs once every plugin is set up and linked, before the commands are handed over or any
	 * service starts; a failure stops the boot, so a broken setup never reaches Discord.
	 */
	preflight?(): Promise<void> | void;
	/** Receives the composed slash commands before any service starts, since Discord registers them as it connects. */
	useCommands?(composed: ComposedInteractions): void;
	/** Starts the agent server, in the background once every service has started; only one plugin has it. */
	agentServer?(): Promise<void>;
	/** Stops a running turn of a channel the plugin's conversations serve; true when one was running. */
	stopTurn?(channel: ChannelKey): boolean;
}
