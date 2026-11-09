import { CharacterError, resolveCharacter } from "../../characters/index.ts";
import type { AgentSeed } from "../agents/agent-store.ts";
import type { BackgroundTarget, ChannelClaim } from "../contract/channels.ts";
import type { ChatCommand } from "../contract/chat-command.ts";
import type { PlaceProvider } from "../contract/places.ts";
import type { ChatSurface } from "../contract/surface.ts";
import {
	compileSessionPlan,
	type SessionTool,
	type ToolSelection,
} from "../domain/sessions.ts";
import type { HttpRoute } from "../http/listeners.ts";
import { TIERS } from "../identity/speakers.ts";
import { NotLinkedError, PluginError } from "../kernel/errors.ts";
import type { ToolContribution } from "../plugin-api/define.ts";
import { type HoldRule, holdChain } from "../plugin-api/holds.ts";
import {
	CONTRIBUTION_KEYS,
	type Contribution,
	type EventHandlers,
	type LinkedSessions,
	type Persona,
	type PluginContext,
	type PromptSection,
	type RoundtablePlugin,
	refuseRemovedEvents,
	refuseRemovedParts,
	refuseRemovedSurfaceMethods,
	type Service,
} from "../plugin-api/plugin.ts";
import { pluginContext } from "../plugin-api/plugin-context.ts";
import {
	type DirectChannelProvider,
	directChannelsPort,
} from "../presence/direct-channels.ts";
import { placePort } from "./place-port.ts";
import { refuseShellTools } from "../runtime/chat-only.ts";
import type { ToolTierTable } from "../runtime/tool-tiers.ts";
import { ChatCommandSources, claimChatCommand } from "./chat-commands.ts";
import {
	checkSurfacePrefix,
	claimDirectChannel,
	claimPersona,
	claimTarget,
	Names,
} from "./claims.ts";
import { PlaceClaims } from "./places.ts";
import { ServiceRegistry } from "./services.ts";
import { surfaceService } from "./surface-service.ts";

/** What a host gives `collectContributions` of the context; it makes the rest from what the plugins contribute. */
export type ContributionBase = Omit<
	PluginContext,
	"services" | "directChannels" | "places"
>;

/** Everything the plugins contributed, in contribution order. */
export interface Registry {
	services: Service[];
	/** The plugin that contributed each service. */
	servicePlugins: Map<Service, string>;
	handlers: { plugin: string; events: EventHandlers }[];
	routes: HttpRoute[];
	holdRules: HoldRule[];
	piPackages: string[];
	sessionTools: SessionTool[];
	channels: ChannelClaim[];
	/** The contributed chat surfaces, each also in `services` as `surface:<prefix>`. */
	surfaces: ChatSurface[];
	/** The contributed place providers, in contribution order; the host adds a derived one for a room surface without one. */
	places: PlaceProvider[];
	personas: Persona[];
	backgroundTargets: BackgroundTarget[];
	/** The contributed direct channels, in contribution order. */
	directChannels: DirectChannelProvider[];
	dashboard: string[];
	chatCommands: ChatCommand[];
	/** Which of the declared chat commands a loaded extension really registers. */
	chatCommandSources: ChatCommandSources;
	tools: ToolContribution[];
	seeds: AgentSeed[];
	prompt: PromptSection[];
	agentSelections: (() => ToolSelection)[];
	requiredTools: string[];
}

export const emptyRegistry = (): Registry => ({
	services: [],
	servicePlugins: new Map(),
	handlers: [],
	routes: [],
	holdRules: [],
	piPackages: [],
	sessionTools: [],
	channels: [],
	surfaces: [],
	places: [],
	personas: [],
	backgroundTargets: [],
	directChannels: [],
	dashboard: [],
	chatCommands: [],
	chatCommandSources: new ChatCommandSources(),
	tools: [],
	seeds: [],
	prompt: [],
	agentSelections: [],
	requiredTools: [],
});

/** The edit distance between two words, for naming the key a typo meant. */
function distance(a: string, b: string): number {
	const row = Array.from({ length: b.length + 1 }, (_, i) => i);
	for (let i = 1; i <= a.length; i++) {
		let previous = row[0] ?? 0;
		row[0] = i;
		for (let j = 1; j <= b.length; j++) {
			const above = row[j] ?? 0;
			row[j] = Math.min(
				above + 1,
				(row[j - 1] ?? 0) + 1,
				previous + (a[i - 1] === b[j - 1] ? 0 : 1),
			);
			previous = above;
		}
	}
	return row[b.length] ?? 0;
}

/** The known name nearest to `word`, when one is close enough to be what was meant. */
export function nearest(
	word: string,
	known: readonly string[],
): string | undefined {
	let best: { name: string; distance: number } | undefined;
	for (const name of known) {
		const d = distance(word.toLowerCase(), name.toLowerCase());
		if (!best || d < best.distance) best = { name, distance: d };
	}
	return best && best.distance <= Math.max(2, Math.floor(word.length / 3))
		? best.name
		: undefined;
}

/** Refuses a contribution with a key the contract does not define, naming the nearest one. */
function checkKeys(plugin: string, contribution: Contribution): void {
	for (const key of Object.keys(contribution)) {
		if ((CONTRIBUTION_KEYS as readonly string[]).includes(key)) continue;
		const meant = nearest(key, CONTRIBUTION_KEYS);
		throw new PluginError(
			`plugin ${plugin}: setup returned an unknown part "${key}".${
				meant ? ` Did you mean "${meant}"?` : ""
			} The parts are ${CONTRIBUTION_KEYS.join(", ")}.`,
		);
	}
}

/** Refuses a seed whose `character` the characters module would not resolve. */
function checkSeedCharacters(
	plugin: string,
	seeds: readonly AgentSeed[],
): void {
	for (const seed of seeds) {
		if (seed.character === undefined) continue;
		try {
			resolveCharacter(seed.character);
		} catch (error) {
			if (!(error instanceof CharacterError)) throw error;
			throw new PluginError(
				`plugin ${plugin}: seed "${seed.name}" has a bad character, field "${error.field}": ${error.message}.`,
			);
		}
	}
}

/** The selections' tools and groups, each once, in the order the plugins gave them. */
function mergeSelections(
	selections: readonly (() => ToolSelection)[],
): ToolSelection {
	const read = selections.map((selection) => selection());
	return {
		tools: [...new Set(read.flatMap((s) => s.tools))],
		groups: [...new Set(read.flatMap((s) => s.groups))],
	};
}

/**
 * Sets up every plugin in order and collects what each adds. A plugin that adds nothing, that
 * reuses a name, or whose setup throws or returns a part the contract does not have is refused
 * with its name and what to fix. The context's `directChannels` are the contributed ones, read
 * once every plugin is set up.
 */
export async function collectContributions(
	plugins: readonly RoundtablePlugin[],
	base: ContributionBase,
	tiers: ToolTierTable,
	services: ServiceRegistry = new ServiceRegistry(plugins),
): Promise<Registry> {
	const registry = emptyRegistry();
	let collected = false;
	const context: Omit<PluginContext, "services"> = {
		...base,
		directChannels: directChannelsPort(
			() => {
				if (!collected)
					throw new NotLinkedError(
						"direct channels are linked once every plugin is set up. Use them from a service's start, a handler, or a session tool, not during setup.",
					);
				return registry.directChannels;
			},
			base.surfaces,
			base.logger,
		),
		places: placePort(() => {
			if (!collected)
				throw new NotLinkedError(
					"place providers are linked once every plugin is set up. Use them from a service's start, a handler, or a session tool, not during setup.",
				);
			return { surfaces: registry.surfaces, providers: registry.places };
		}, base.surfaces),
	};
	const serviceNames = new Names("service");
	const sessionTools = new Names("session tool");
	const holds = new Names("hold rule");
	const surfaces = new Names("surface");
	const placeClaims = new PlaceClaims();
	const directChannelNames = new Names("direct channel");
	const personaKinds = new Map<string, string>();
	const targetNames = new Map<string, string>();
	const chatCommandNames = new Map<string, string>();
	for (const plugin of plugins) {
		let contribution: Contribution;
		try {
			contribution = await services.setUp(plugin, () =>
				plugin.setup(
					pluginContext(plugin, context, services.forPlugin(plugin)),
				),
			);
		} catch (error) {
			if (error instanceof PluginError) throw error;
			// Some messages end in a period already, such as a NotLinkedError's.
			const reason = (
				error instanceof Error ? error.message : String(error)
			).replace(/\.+$/, "");
			throw new PluginError(
				`plugin ${plugin.name}: setup failed: ${reason}. Fix the error, or remove the plugin.`,
				{ cause: error },
			);
		}
		if (typeof contribution !== "object" || contribution === null)
			throw new PluginError(
				`plugin ${plugin.name}: setup must return an object of the parts it adds; return {} to add none.`,
			);
		refuseRemovedParts(plugin.name, contribution);
		checkKeys(plugin.name, contribution);
		if (contribution.events)
			refuseRemovedEvents(plugin.name, contribution.events);
		const {
			events,
			http = [],
			holdRules = [],
			piPackages = [],
			channels = [],
			surfaces: contributedSurfaces = [],
			places = [],
			personas = [],
			backgroundTargets = [],
			directChannels = [],
			dashboard = [],
			chatCommands = [],
			tools = [],
			seeds = [],
			prompt = [],
			requiredTools = [],
		} = contribution;
		const parts = [
			contribution.services ?? [],
			http,
			holdRules,
			piPackages,
			contribution.sessionTools ?? [],
			channels,
			contributedSurfaces,
			places,
			personas,
			backgroundTargets,
			directChannels,
			dashboard,
			chatCommands,
			tools,
			seeds,
			prompt,
			requiredTools,
			contribution.agentSelection ? [contribution.agentSelection] : [],
			Object.keys(contribution.toolTiers ?? {}),
		];
		const declares =
			(plugin.migrations?.length ?? 0) > 0 ||
			(plugin.provides?.length ?? 0) > 0 ||
			Object.keys(plugin.providers ?? {}).length > 0 ||
			plugin.preflight !== undefined ||
			// It works through a service it read, such as the Discord plugin's command registrar.
			services.reads(plugin);
		if (!declares && !events && parts.every((part) => part.length === 0))
			throw new PluginError(
				`plugin ${plugin.name} adds nothing. Give it a part (tools, services, channels, and so on), a migration, or a provider, or remove it.`,
			);
		// Its surfaces start before its own services, which may rely on the connection.
		for (const surface of contributedSurfaces) {
			refuseRemovedSurfaceMethods(plugin.name, surface);
			checkSurfacePrefix(plugin.name, surface.surface);
			surfaces.claim(plugin.name, surface.surface);
			const service = surfaceService(surface, context);
			serviceNames.claim(plugin.name, service.name);
			registry.surfaces.push(surface);
			registry.services.push(service);
			registry.servicePlugins.set(service, plugin.name);
		}
		for (const service of contribution.services ?? []) {
			serviceNames.claim(plugin.name, service.name);
			registry.services.push(service);
			registry.servicePlugins.set(service, plugin.name);
		}
		for (const provider of places) {
			placeClaims.claim(plugin.name, provider);
			registry.places.push(provider);
		}
		for (const persona of personas)
			claimPersona(personaKinds, plugin.name, persona);
		for (const target of backgroundTargets)
			claimTarget(targetNames, plugin.name, target);
		for (const provider of directChannels)
			claimDirectChannel(directChannelNames, plugin.name, provider);
		for (const rule of holdRules) holds.claim(plugin.name, rule.name);
		for (const tool of contribution.sessionTools ?? []) {
			sessionTools.claim(plugin.name, tool.name);
			registry.sessionTools.push(tool);
		}
		if (contribution.toolTiers) {
			for (const [tool, tier] of Object.entries(contribution.toolTiers))
				if (!(TIERS as readonly string[]).includes(tier))
					throw new PluginError(
						`plugin ${plugin.name}: toolTiers names tool ${tool} at tier ${JSON.stringify(tier)}; use one of ${TIERS.join(", ")}.`,
					);
			tiers.declare(plugin.name, contribution.toolTiers);
		}
		for (const tool of tools) {
			tiers.declare(plugin.name, { [tool.name]: tool.minTier });
			sessionTools.claim(plugin.name, tool.session.name);
			registry.sessionTools.push(tool.session);
			registry.tools.push(tool);
			if (tool.hold) {
				holds.claim(plugin.name, tool.hold.name);
				registry.holdRules.push(tool.hold);
			}
		}
		if (contribution.agentSelection) {
			if (context.env.agentTools === "chat-only")
				refuseShellTools(
					contribution.agentSelection().tools,
					`plugin ${plugin.name}: agentSelection`,
				);
			registry.agentSelections.push(contribution.agentSelection);
		}
		if (events) registry.handlers.push({ plugin: plugin.name, events });
		registry.routes.push(...http);
		registry.holdRules.push(...holdRules);
		registry.piPackages.push(...piPackages);
		registry.channels.push(...channels);
		registry.personas.push(...personas);
		registry.backgroundTargets.push(...backgroundTargets);
		registry.directChannels.push(...directChannels);
		registry.dashboard.push(...dashboard);
		for (const command of chatCommands) {
			claimChatCommand(chatCommandNames, plugin.name, command);
			registry.chatCommandSources.declare(command, {
				packages: piPackages,
				sessionTools: [
					...(contribution.sessionTools ?? []),
					...tools.map((tool) => tool.session),
				].map((tool) => tool.name),
			});
		}
		registry.chatCommands.push(...chatCommands);
		checkSeedCharacters(plugin.name, seeds);
		registry.seeds.push(...seeds);
		registry.prompt.push(...prompt);
		registry.requiredTools.push(...requiredTools);
	}
	services.settle();
	placeClaims.check(registry.surfaces);
	collected = true;
	return registry;
}

/** Links the collected session parts; throws PluginError on a clash. */
export function linkSessions(registry: Registry): LinkedSessions {
	const personas = new Map(
		registry.personas.map((persona) => [persona.kind, persona] as const),
	);
	return {
		holds: holdChain(registry.holdRules),
		// A package two plugins ask for loads once, where it was first asked for.
		piPackages: [...new Set(registry.piPackages)],
		plan: compileSessionPlan(registry.sessionTools),
		seeds: registry.seeds,
		prompt: registry.prompt,
		persona: (kind) => personas.get(kind)?.prompt(),
		personaMemory: (kind) => personas.get(kind)?.memory ?? "speaker",
		requiredTools: [...new Set(registry.requiredTools)],
		agentTools: registry.tools.flatMap((t) => (t.agent ? [t.name] : [])),
		agentSelection: () => mergeSelections(registry.agentSelections),
		chatCommands: registry.chatCommandSources,
	};
}
