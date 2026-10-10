import type { SQL } from "bun";
import type { AgentSeed } from "./agents/agent-store.ts";
import type { AttachmentPort } from "./contract/attachments.ts";
import type {
	BackgroundTarget,
	ChannelClaim,
	ConversationPort,
	QueuePort,
} from "./contract/channels.ts";
import type { Providers, ResolvedProviders } from "./contract/providers.ts";
import type { ServiceKey, Services } from "./contract/services.ts";
import type { ChatSurface, SurfacePort } from "./contract/surface.ts";
import type { Migration } from "./db/migrations.ts";
import type { ToolContribution } from "./define.ts";
import type { TurnProgress } from "./domain/progress.ts";
import { PluginError } from "./errors.ts";
import type { HoldCheck, HoldRule } from "./holds.ts";
import type { HttpRoute } from "./http/listeners.ts";
import type { Locale } from "./i18n/index.ts";
import type { Logger } from "./log.ts";
import type {
	DirectChannelProvider,
	DirectChannels,
} from "./presence/direct-channels.ts";
import type { ConversationTurns } from "./routing/conversation-turns.ts";
import type {
	AgentTurnScope,
	ChannelKey,
	SessionPlan,
	SessionTool,
	ToolSelection,
} from "./sessions.ts";
import type { Speaker, Tier } from "./speakers.ts";
import type { ToolTiers } from "./tool-tiers.ts";

/**
 * A long-lived part of a plugin. Services start in registration order and stop in reverse,
 * so one registered earlier outlives those registered after it.
 */
export interface Service {
	name: string;
	start?(): Promise<void> | void;
	/**
	 * Starts once every service's `start` and the HTTP listeners are up, without holding up the
	 * boot: a failure is logged and heard as `serviceStarted` with `failed`, never fatal, and the
	 * other services' background starts still run. `stop` runs for it like for any started service.
	 */
	startInBackground?(): Promise<void>;
	stop?(): Promise<void> | void;
	/** Work still running or waiting, one entry each; the shutdown drain waits until every list is empty. */
	busy?(): string[];
}

/** How a service's background start ended. */
export type ServiceStartOutcome = "ready" | "failed";

/** A service's `startInBackground` ended, as a handler hears of it. */
export interface ServiceStartedEvent {
	/** The plugin that contributed the service. */
	plugin: string;
	service: string;
	outcome: ServiceStartOutcome;
}

/** One turn, as a handler hears of it: an agent's, or a conversation run through `context.turns`. */
export interface TurnEvent {
	/** The agent whose turn it is; absent for a conversation of another kind, such as a study room's. */
	agent?: string;
	/** The conversation's kind: "agent" for an agent's turn, else the kind the turn ran as, such as "owner" or "study". */
	kind: string;
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

/** What a running turn wrote or ran, as a handler hears of it, between its start and its end. */
export interface TurnProgressEvent extends TurnEvent {
	progress: TurnProgress;
}

/** What a plugin may react to; a handler that throws is logged and never stops the others. */
export interface EventHandlers {
	/**
	 * A service's background start ended, in the order the services were contributed; the rest
	 * of the process runs either way. The agent server's is the `AGENT_TEAM_SERVICE` service of
	 * the `AGENT_SERVER_PLUGIN` plugin.
	 */
	serviceStarted?(event: ServiceStartedEvent): Promise<void> | void;
	/** An agent's turn, or a turn run through `context.turns`, began. */
	turnStarted?(turn: TurnEvent): Promise<void> | void;
	/** A turn that began ended, however it ended. */
	turnEnded?(turn: TurnEndEvent): Promise<void> | void;
	/**
	 * A turn run through `context.turns` wrote text or ran a tool, as it goes: text joined over a
	 * short interval, and each tool's name with a short preview of its arguments. Turns on a runtime
	 * without live progress report none.
	 */
	turnProgress?(event: TurnProgressEvent): Promise<void> | void;
	/** The team changed: an agent or group was created, edited, arranged, archived, or started over. */
	changed?(): Promise<void> | void;
	/** The shutdown drain ended, before any service stops; `left` is the work it gave up on. */
	shutdown?(left: readonly string[]): Promise<void> | void;
}

/** What the core reports to the plugins' handlers. */
export interface EventSink {
	turnStarted(turn: TurnEvent): void;
	turnEnded(turn: TurnEndEvent): void;
	/** Optional, so a sink of your own written before it still fits. */
	turnProgress?(event: TurnProgressEvent): void;
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

/**
 * The system prompt of every non-agent conversation of one kind. A conversation's kind is the
 * string its claim returns from `startFresh` and passes as `kind` to `context.turns.run`.
 */
export interface Persona {
	/** The conversation kind the prompt is for; "agent" is reserved for the agent server's own. */
	kind: string;
	/**
	 * The prompt text, read when a conversation's session is made, so text from the message catalog
	 * is in the host's language.
	 */
	prompt(): string;
	/**
	 * Whose memory its conversations read: `"speaker"` (the default), the conversation's person in a
	 * private one and each turn's speaker in a shared one, or `"none"`: no memory tools and no
	 * memory in the prompt.
	 */
	memory?: "speaker" | "none";
}

/** What a plugin adds to the process; a plugin that adds nothing is refused. */
export interface Contribution {
	services?: Service[];
	events?: EventHandlers;
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
	/**
	 * Chat networks the plugin connects the host to, one per channel-key prefix. Each starts as a
	 * service named `surface:<prefix>` before the plugin's own services.
	 */
	surfaces?: readonly ChatSurface[];
	/**
	 * The system prompts of conversation kinds the plugin owns, one per kind. A plugin that owns the
	 * owner's own conversations contributes the `"owner"` kind's prompt; without one those
	 * conversations start with an empty system prompt.
	 */
	personas?: readonly Persona[];
	/**
	 * Tools startup refuses to run without, besides those each session tool requires: the host's
	 * preflight builds a session and fails when one of these names is not registered. Merged over
	 * every plugin, each name once.
	 */
	requiredTools?: readonly string[];
	/**
	 * The background targets the plugin's claims answer, one per name across every plugin: a
	 * schedule or delegated task names one, and a turn for a target nobody contributes is skipped.
	 */
	backgroundTargets?: readonly BackgroundTarget[];
	/**
	 * Ways to reach a person on their own, such as a chat network's direct messages, one per name
	 * across every plugin. The host reaches a person through the first, in contribution order,
	 * that reaches them: `notify` sends there, and a conversation no chat surface carries keeps its
	 * schedules and delegated reports in the creator's.
	 */
	directChannels?: readonly DirectChannelProvider[];
	/** Lines the agent server's dashboard shows under its title, such as links, in contribution order. */
	dashboard?: readonly string[];
	/** Tools the plugin adds, each with the lowest tier that may use it; built with `defineTool`. */
	tools?: readonly ToolContribution[];
	/**
	 * The lowest tier that may use each of the plugin's raw session tools, by tool name: the tools
	 * its `sessionTools` extensions register. An operator's `toolTiers` still wins; a tool nobody
	 * names needs the owner. Two plugins naming one tool is a PluginError; use `tools` instead
	 * when `defineTool` builds the tool.
	 */
	toolTiers?: Readonly<Record<string, Tier>>;
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
	"http",
	"holdRules",
	"piPackages",
	"sessionTools",
	"channels",
	"surfaces",
	"personas",
	"backgroundTargets",
	"directChannels",
	"dashboard",
	"tools",
	"toolTiers",
	"seeds",
	"prompt",
	"agentSelection",
	"requiredTools",
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
	/** The prompt of a conversation kind, from the plugin that contributes its persona; undefined when none does. */
	persona(kind: string): string | undefined;
	/** Whose memory conversations of the kind read, as its persona declares; "speaker" when it declares none. */
	personaMemory?(kind: string): "speaker" | "none";
	/** Every tool name plugins require at startup, each once. */
	requiredTools: readonly string[];
	/** The tools plugins defined for agents, by name. */
	agentTools: readonly string[];
	/** Every plugin's agent selection merged, read before each agent turn. */
	agentSelection(): ToolSelection;
}

/** The host's own locale and time zone, as its plugins read them. */
export interface HostEnv {
	readonly locale: Locale;
	/** The IANA zone the host was configured with. */
	readonly timeZone: string;
	/** The current instant. */
	now(): Date;
}

/** What the host gives every plugin. */
export interface PluginContext {
	logger: Logger;
	/** The host's locale and time zone, fixed for the run. */
	env: HostEnv;
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
	/**
	 * Files a plugin takes from a person outside a turn, such as an upload, kept for a conversation
	 * until a turn uses them; a call throws PluginError when the host has no `dataDir`.
	 */
	attachments: AttachmentPort;
	/** Every contributed chat surface, chosen by a channel's prefix; calls during setup throw NotLinkedError. */
	surfaces: SurfacePort;
	/** Every plugin's direct channels, which reach a person on their own; calls during setup throw NotLinkedError. */
	directChannels: DirectChannels;
	/** Runs conversation turns of any kind over the runtime and the surfaces; calls during setup throw NotLinkedError. */
	turns: ConversationTurns;
	/** The host's one connection pool, migrated before any setup; throws PluginError without a database. */
	database(): SQL;
	/**
	 * The services plugins provide to each other, read by key: `services.get(SCHEDULES)`. Reading one
	 * before its plugin has set up throws a PluginError naming the plugin to register first.
	 */
	services: Services;
	/** Each provider slot, from the plugin that fills it or the core's default; `filled` names the slots a plugin fills. */
	providers: ResolvedProviders;
	/** Every plugin's dashboard lines, in contribution order; throws NotLinkedError during setup. */
	dashboard(): readonly string[];
	/**
	 * The credential the host's model login holds for a provider, such as `openai-codex`: the same
	 * login the agents use. Resolves to `undefined` when the host has none for that provider, and
	 * never throws for that. The value is a secret: keep it out of logs and error messages.
	 */
	apiKey(provider: string): Promise<string | undefined>;
}

/**
 * An identity a plugin's own credential stands for, such as the bearer token of an endpoint it
 * serves, and the principal it speaks as.
 */
export interface PluginIdentity {
	/**
	 * Written `token:<subject>`, such as `token:remote-mcp`. Only the `token` provider is accepted:
	 * a surface's identity, such as `discord:` or `oidc:`, is a person's own account, linked by
	 * `access.owners` or the CLI, and any other provider stops the boot with a ConfigError.
	 */
	identity: string;
	/** The id of the principal it stands for; the primary owner, the first of `access.owners`, when absent. */
	principal?: string;
}

export interface RoundtablePlugin {
	name: string;
	/** The plugin's tables; the host runs every plugin's, in registration order, before any setup. */
	migrations?: readonly Migration[];
	/**
	 * Identities the plugin's own credentials stand for, read before any setup. At every boot the
	 * identity plugin links each to its principal as the plugin's (`roundtable principal list` shows
	 * them as `plugin`), moves one bound to another principal than at the last boot, and unlinks one
	 * no plugin declares any more. An identity of a provider other than `token`, one linked to
	 * someone else, another plugin's, a principal that does not exist, or the system principal stops
	 * the boot with a ConfigError. A declared
	 * identity is never admitted or claimed at a first contact, and `IDENTITY.principalOf` reads
	 * whom it stands for.
	 */
	identities?: readonly PluginIdentity[];
	/** The provider slots the plugin fills, resolved before any setup; two plugins cannot fill one slot. */
	providers?: Partial<Providers>;
	/**
	 * The services this plugin's setup provides with `context.services.provide`; the host reads the
	 * list before any setup, and refuses the plugin when setup returns without providing one.
	 */
	provides?: readonly ServiceKey<unknown>[];
	/**
	 * The services this plugin's setup reads with `get`, so the host can check them before any
	 * setup and any migration: a key no registered plugin provides, or one provided by a plugin
	 * registered after this one, is a PluginError that names both plugins and the fix. A service
	 * read only after startup, from a callback, is `services.lazy` instead, which does not depend
	 * on order. Leave out a service read with `find`, since that one may be absent.
	 */
	requires?: readonly ServiceKey<unknown>[];
	/**
	 * Services this plugin replaces. The host drops the plugin that provides them and sets this one
	 * up where it stood, so it may read what the plugins before that place provide and nothing
	 * after. It refuses a key no other plugin provides, a key two plugins replace, a service
	 * replaced but not listed in this plugin's `provides`, and a partial replacement, where the
	 * dropped plugin provides a service this one does not replace.
	 */
	replaces?: readonly ServiceKey<unknown>[];
	setup(context: PluginContext): Promise<Contribution> | Contribution;
	/**
	 * Runs once every plugin is set up and linked, before any service starts; a failure stops the
	 * boot, so a broken setup never reaches Discord. The Discord plugin composes the slash commands
	 * here, so a plugin adds its own from setup.
	 */
	preflight?(): Promise<void> | void;
}

/**
 * The plugin fields of 0.1.0 that are gone, each with what replaces it. The host refuses a
 * plugin that still has one, so a plugin written for 0.1.0 fails at once instead of being ignored.
 */
const REMOVED_PLUGIN_FIELDS = {
	useCommands:
		"the composed slash commands go to the Discord plugin's surface, not to a plugin; add the commands from setup with context.services.get(DISCORD).commands.add(...), with DISCORD from pi-roundtable/discord",
	agentServer:
		"give the plugin a service with startInBackground, and hear how it ended in a serviceStarted event handler",
	stopTurn:
		"put stop(channel) on the channel claim that owns the channel; the router asks only the owning claim",
} as const;

/** The contribution parts of 0.1.0 that are gone, each with what replaces it. */
const REMOVED_PARTS = {
	interactions:
		"slash commands belong to the Discord plugin now; add them from setup with context.services.get(DISCORD).commands.add({ module, rootOptions }), with DISCORD from pi-roundtable/discord",
} as const;

/** The chat surface methods of 0.1.0 that are gone, each with what replaces it. */
const REMOVED_SURFACE_METHODS = {
	useCommands:
		"the host no longer composes slash commands or hands them to a surface; the Discord plugin composes them, and a plugin adds its own with context.services.get(DISCORD).commands.add(...) from pi-roundtable/discord",
} as const;

const REMOVED_EVENT = {
	agentServer:
		"hear serviceStarted instead, which names the plugin and service whose background start ended",
} as const;

/**
 * The context one plugin's setup gets: the host's parts and that plugin's view of the services.
 * `context.core` of 0.1.0 is gone; reading it throws a PluginError naming `context.services`, where
 * a plugin written for 0.1.0 meets it on its first line, instead of getting `undefined`.
 */
export function pluginContext(
	plugin: RoundtablePlugin,
	base: Omit<PluginContext, "services">,
	services: Services,
): PluginContext {
	// Every line a plugin logs carries its name.
	const context = {
		...base,
		logger: base.logger.child({ plugin: plugin.name }),
		services,
	};
	Object.defineProperty(context, "core", {
		enumerable: false,
		get() {
			throw new PluginError(
				`plugin ${plugin.name}: context.core was removed in 0.2.0; read a service with context.services.get(KEY), for example services.get(SCHEDULES), and provide one with services.provide(KEY, value) after listing KEY in the plugin's provides.`,
			);
		},
	});
	return context;
}

/**
 * Refuses a plugin that still has a field of 0.1.0 that is gone, naming what replaces it, so it
 * fails where it is written or when the host links it instead of being ignored.
 */
export function refuseRemovedFields(plugin: RoundtablePlugin): void {
	for (const [field, replacement] of Object.entries(REMOVED_PLUGIN_FIELDS))
		if (field in plugin)
			throw new PluginError(
				`plugin ${plugin.name}: "${field}" was removed in 0.2.0; ${replacement}.`,
			);
}

/** Refuses a contribution part of 0.1.0 that is gone, naming what replaces it. */
export function refuseRemovedParts(
	plugin: string,
	contribution: Contribution,
): void {
	for (const [part, replacement] of Object.entries(REMOVED_PARTS))
		if (part in contribution)
			throw new PluginError(
				`plugin ${plugin}: the "${part}" part was removed in 0.2.0; ${replacement}.`,
			);
}

/** Refuses a chat surface that still has a method of 0.1.0 that is gone, naming what replaces it. */
export function refuseRemovedSurfaceMethods(
	plugin: string,
	surface: ChatSurface,
): void {
	for (const [method, replacement] of Object.entries(REMOVED_SURFACE_METHODS))
		if (method in surface)
			throw new PluginError(
				`plugin ${plugin}: surface ${surface.surface} has ${method}, which was removed in 0.2.0; ${replacement}.`,
			);
}

/** Refuses an event handler of 0.1.0 that is gone, naming what replaces it. */
export function refuseRemovedEvents(
	plugin: string,
	events: EventHandlers,
): void {
	for (const [event, replacement] of Object.entries(REMOVED_EVENT))
		if (event in events)
			throw new PluginError(
				`plugin ${plugin}: the "${event}" event was removed in 0.2.0; ${replacement}.`,
			);
}
