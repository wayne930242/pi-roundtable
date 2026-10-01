import type { AgentSeed } from "../agents/agent-store.ts";
import type { BackgroundTarget, ChannelClaim } from "../contract/channels.ts";
import type { ChatSurface } from "../contract/surface.ts";
import type { ToolContribution } from "../define.ts";
import { PluginError } from "../errors.ts";
import { type HoldRule, holdChain } from "../holds.ts";
import type { HttpRoute } from "../http/listeners.ts";
import {
	CONTRIBUTION_KEYS,
	type Contribution,
	type EventHandlers,
	type LinkedSessions,
	type Persona,
	type PluginContext,
	type PromptSection,
	pluginContext,
	type RoundtablePlugin,
	refuseRemovedEvents,
	refuseRemovedParts,
	refuseRemovedSurfaceMethods,
	type Service,
} from "../plugin.ts";
import {
	compileSessionPlan,
	type SessionTool,
	type ToolSelection,
} from "../sessions.ts";
import { TIERS } from "../speakers.ts";
import type { ToolTierTable } from "../tool-tiers.ts";
import { ServiceRegistry } from "./services.ts";

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
	personas: Persona[];
	backgroundTargets: BackgroundTarget[];
	dashboard: string[];
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
	personas: [],
	backgroundTargets: [],
	dashboard: [],
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

/** Which plugin registered each name of one kind, so a clash names both. */
class Names {
	readonly #owners = new Map<string, string>();

	constructor(private readonly kind: string) {}

	claim(plugin: string, name: string): void {
		const other = this.#owners.get(name);
		if (other !== undefined)
			throw new PluginError(
				`plugin ${plugin}: ${this.kind} ${name} is already registered by plugin ${other}. Rename one of the two.`,
			);
		this.#owners.set(name, plugin);
	}
}

/** The kind of a conversation the agent server runs itself, which no plugin's persona may take. */
const RESERVED_KIND = "agent";

/**
 * Refuses a persona without a kind, for the reserved agent kind, or for a kind another plugin's
 * persona already has, so a conversation's prompt is never a matter of plugin order.
 */
function claimPersona(
	kinds: Map<string, string>,
	plugin: string,
	persona: Persona,
): void {
	const { kind } = persona;
	if (typeof kind !== "string" || kind === "")
		throw new PluginError(
			`plugin ${plugin}: a persona needs a kind, a non-empty string such as "study", and got ${JSON.stringify(kind)}.`,
		);
	if (kind === RESERVED_KIND)
		throw new PluginError(
			`plugin ${plugin}: the persona kind "${RESERVED_KIND}" is reserved for the agent server's agents. Give the persona the kind of your own conversations.`,
		);
	if (typeof persona.prompt !== "function")
		throw new PluginError(
			`plugin ${plugin}: the persona of kind "${kind}" needs a prompt() that returns its text.`,
		);
	const other = kinds.get(kind);
	if (other !== undefined)
		throw new PluginError(
			`plugin ${plugin}: persona kind "${kind}" is already registered by plugin ${other}. Keep one persona per kind.`,
		);
	kinds.set(kind, plugin);
}

/**
 * Refuses a background target without a name or a label, or whose name another plugin's target
 * already has, so a stored schedule's target never depends on plugin order.
 */
function claimTarget(
	names: Map<string, string>,
	plugin: string,
	target: BackgroundTarget,
): void {
	const { name } = target;
	if (typeof name !== "string" || name === "")
		throw new PluginError(
			`plugin ${plugin}: a background target needs a name, a non-empty string such as "support", and got ${JSON.stringify(name)}.`,
		);
	if (typeof target.label !== "function")
		throw new PluginError(
			`plugin ${plugin}: the background target "${name}" needs a label(locale) that returns its name for lists.`,
		);
	const other = names.get(name);
	if (other !== undefined)
		throw new PluginError(
			`plugin ${plugin}: background target "${name}" is already registered by plugin ${other}. Keep one target per name.`,
		);
	names.set(name, plugin);
}

/** The surface's own words for what a prefix must be, checked before its service is named. */
function checkSurfacePrefix(plugin: string, prefix: unknown): void {
	if (typeof prefix !== "string" || prefix === "" || /[:\s]/.test(prefix))
		throw new PluginError(
			`plugin ${plugin}: a surface is named by the prefix of its channel keys, a non-empty word without a colon or space, such as discord; got ${JSON.stringify(prefix)}.`,
		);
}

/**
 * The surface as a service: it starts with the router's `handle` as its delivery, which drops
 * and logs a message that belongs to another prefix, and stops with the surface.
 */
function surfaceService(
	surface: ChatSurface,
	context: Pick<PluginContext, "logger" | "conversations">,
): Service {
	const { logger, conversations } = context;
	return {
		name: `surface:${surface.surface}`,
		start: () =>
			surface.start((message) => {
				if (!message.channel.startsWith(`${surface.surface}:`)) {
					logger.error(
						{ surface: surface.surface, channel: message.channel },
						"a surface delivered a message of another prefix; dropped",
					);
					return;
				}
				void conversations.handle(message);
			}),
		...(surface.stop ? { stop: () => surface.stop?.() } : {}),
	};
}

/**
 * Sets up every plugin in order and collects what each adds. A plugin that adds nothing, that
 * reuses a name, or whose setup throws or returns a part the contract does not have is refused
 * with its name and what to fix.
 */
export async function collectContributions(
	plugins: readonly RoundtablePlugin[],
	context: Omit<PluginContext, "services">,
	tiers: ToolTierTable,
	services: ServiceRegistry = new ServiceRegistry(plugins),
): Promise<Registry> {
	const registry = emptyRegistry();
	const serviceNames = new Names("service");
	const sessionTools = new Names("session tool");
	const holds = new Names("hold rule");
	const surfaces = new Names("surface");
	const personaKinds = new Map<string, string>();
	const targetNames = new Map<string, string>();
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
			personas = [],
			backgroundTargets = [],
			dashboard = [],
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
			personas,
			backgroundTargets,
			dashboard,
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
		for (const persona of personas)
			claimPersona(personaKinds, plugin.name, persona);
		for (const target of backgroundTargets)
			claimTarget(targetNames, plugin.name, target);
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
		if (contribution.agentSelection)
			registry.agentSelections.push(contribution.agentSelection);
		if (events) registry.handlers.push({ plugin: plugin.name, events });
		registry.routes.push(...http);
		registry.holdRules.push(...holdRules);
		registry.piPackages.push(...piPackages);
		registry.channels.push(...channels);
		registry.personas.push(...personas);
		registry.backgroundTargets.push(...backgroundTargets);
		registry.dashboard.push(...dashboard);
		registry.seeds.push(...seeds);
		registry.prompt.push(...prompt);
		registry.requiredTools.push(...requiredTools);
	}
	services.settle();
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
		requiredTools: [...new Set(registry.requiredTools)],
		agentTools: registry.tools.flatMap((t) => (t.agent ? [t.name] : [])),
		agentSelection: () => mergeSelections(registry.agentSelections),
	};
}
