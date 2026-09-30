import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SQL } from "bun";
import type { ConversationPort } from "./core/contract/channels.ts";
import type { Providers } from "./core/contract/providers.ts";
import { NotLinkedError, PluginError } from "./core/errors.ts";
import { EventBus } from "./core/events.ts";
import { silentLogger } from "./core/log.ts";
import type {
	Contribution,
	LinkedSessions,
	PluginContext,
	RoundtablePlugin,
	TurnEndEvent,
	TurnEvent,
} from "./core/plugin.ts";
import {
	collectContributions,
	linkSessions,
} from "./core/registry/contributions.ts";
import { resolveProviders } from "./core/registry/providers.ts";
import { ChannelQueue } from "./core/routing/channel-queue.ts";
import { CoreRegistry } from "./core/services.ts";
import type { SessionContext } from "./core/sessions.ts";
import type { Speaker } from "./core/speakers.ts";
import { type ToolTierTable, toolTiers } from "./core/tool-tiers.ts";

export interface TestPluginOptions {
	database?: SQL;
	providers?: Partial<Providers>;
}

export interface RecordedEvent {
	name: "turnStarted" | "turnEnded" | "changed";
	turn?: TurnEvent | TurnEndEvent;
}

export interface TestPluginResult {
	contribution: Contribution;
	tools: readonly string[];
	tiers: ToolTierTable;
	events: RecordedEvent[];
	runTool(
		name: string,
		args: Record<string, unknown>,
		options?: { speaker?: Speaker },
	): Promise<string>;
	stop(): Promise<void>;
}

/** The same pre-link failures and wording the host exposes during setup. */
const NOT_LINKED = {
	conversations:
		"conversations are linked once every plugin is set up. Use them from a service's start or from a handler, not during setup.",
	sessions:
		"session parts are linked once every plugin is set up. Call sessions() from a service's start or from a handler, not during setup.",
	dashboard:
		"dashboard lines are linked once every plugin is set up. Call dashboard() from a service's start or from a handler, not during setup.",
};

function unlinked(part: keyof typeof NOT_LINKED): never {
	throw new NotLinkedError(NOT_LINKED[part]);
}

/** Build one plugin without Discord or PostgreSQL, retaining the host's validation and tier logic. */
export async function testPlugin(
	plugin: RoundtablePlugin,
	options: TestPluginOptions = {},
): Promise<TestPluginResult> {
	const logger = silentLogger();
	const tiers = toolTiers();
	const bus = new EventBus(logger);
	const events: RecordedEvent[] = [];
	const core = new CoreRegistry();
	let linked: LinkedSessions | undefined;
	const conversations: ConversationPort = {
		handle: async () => unlinked("conversations"),
		background: async () => unlinked("conversations"),
		startFresh: async () => unlinked("conversations"),
		deleteConversation: async () => unlinked("conversations"),
		stop: () => unlinked("conversations"),
		postsInPlace: () => unlinked("conversations"),
	};
	const context: PluginContext = {
		logger,
		sessions: () => linked ?? unlinked("sessions"),
		queue: new ChannelQueue(),
		toolTiers: tiers,
		events: {
			turnStarted: (turn) => {
				events.push({ name: "turnStarted", turn });
				bus.sink.turnStarted(turn);
			},
			turnEnded: (turn) => {
				events.push({ name: "turnEnded", turn });
				bus.sink.turnEnded(turn);
			},
			changed: () => {
				events.push({ name: "changed" });
				bus.sink.changed();
			},
		},
		conversations,
		database: () => {
			if (!options.database) throw new PluginError("no database is configured");
			return options.database;
		},
		core,
		providers: { ...resolveProviders([plugin]), ...options.providers },
		dashboard: () => (linked ? registry.dashboard : unlinked("dashboard")),
	};
	const registry = await collectContributions([plugin], context, tiers);
	linked = linkSessions(registry);
	bus.link(registry.handlers);
	const contribution: Contribution = {
		services: registry.services,
		events: registry.handlers[0]?.events,
		interactions: registry.interactions,
		http: registry.routes,
		holdRules: registry.holdRules,
		piPackages: registry.piPackages,
		sessionTools: registry.sessionTools,
		channels: registry.channels,
		dashboard: registry.dashboard,
		tools: registry.tools,
		seeds: registry.seeds,
		prompt: registry.prompt,
		...(registry.agentSelections.length > 0
			? { agentSelection: linked.agentSelection }
			: {}),
	};
	for (const service of registry.services) await service.start?.();
	let stopped = false;
	return {
		contribution,
		tools: registry.tools.map((tool) => tool.name),
		tiers,
		events,
		async runTool(name, args, runOptions) {
			const tool = registry.tools.find((item) => item.name === name);
			if (!tool) throw new PluginError(`tool ${name} is not registered`);
			const registered: {
				execute(
					id: string,
					params: Record<string, unknown>,
					signal?: AbortSignal,
				): Promise<{
					content: readonly { type: string; text?: string }[];
					isError?: boolean;
				}>;
			}[] = [];
			const session = {
				kind: "agent",
				homeChannel: "test:1",
				turnChannel: "test:1",
				compaction: { wrap: (factory) => factory },
				speaker: () => runOptions?.speaker,
				runTask: async () => {
					throw new Error("test session cannot run tasks");
				},
			} satisfies SessionContext;
			const factory = tool.session.snapshot().factory(session);
			// SAFETY: defineTool's session factory only calls registerTool; the fake captures its definition.
			factory?.({
				registerTool: (definition: (typeof registered)[number]) => {
					registered.push(definition);
				},
			} as unknown as ExtensionAPI);
			const execute = registered[0]?.execute;
			if (!execute)
				throw new PluginError(`tool ${name} did not register in the session`);
			const result = await execute("test-call", args);
			return result.content.map((item) => item.text ?? "").join("\n");
		},
		async stop() {
			if (stopped) return;
			stopped = true;
			await bus.deliver("shutdown", []);
			for (const service of registry.services.toReversed())
				await service.stop?.();
		},
	};
}
