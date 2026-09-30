import type { AgentSeed } from "../agents/agent-store.ts";
import type { ChannelClaim } from "../contract/channels.ts";
import type { InteractionContribution } from "../contract/discord.ts";
import type { ToolContribution } from "../define.ts";
import { PluginError } from "../errors.ts";
import { type HoldRule, holdChain } from "../holds.ts";
import type { HttpRoute } from "../http/listeners.ts";
import {
	CONTRIBUTION_KEYS,
	type Contribution,
	type EventHandlers,
	type LinkedSessions,
	type PluginContext,
	type PromptSection,
	type RoundtablePlugin,
	type Service,
} from "../plugin.ts";
import {
	compileSessionPlan,
	type SessionTool,
	type ToolSelection,
} from "../sessions.ts";
import type { ToolTierTable } from "../tool-tiers.ts";

/** Everything the plugins contributed, in contribution order. */
export interface Registry {
	services: Service[];
	handlers: { plugin: string; events: EventHandlers }[];
	interactions: InteractionContribution[];
	routes: HttpRoute[];
	holdRules: HoldRule[];
	piPackages: string[];
	sessionTools: SessionTool[];
	channels: ChannelClaim[];
	dashboard: string[];
	tools: ToolContribution[];
	seeds: AgentSeed[];
	prompt: PromptSection[];
	agentSelections: (() => ToolSelection)[];
}

export const emptyRegistry = (): Registry => ({
	services: [],
	handlers: [],
	interactions: [],
	routes: [],
	holdRules: [],
	piPackages: [],
	sessionTools: [],
	channels: [],
	dashboard: [],
	tools: [],
	seeds: [],
	prompt: [],
	agentSelections: [],
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

/**
 * Sets up every plugin in order and collects what each adds. A plugin that adds nothing, that
 * reuses a name, or whose setup throws or returns a part the contract does not have is refused
 * with its name and what to fix.
 */
export async function collectContributions(
	plugins: readonly RoundtablePlugin[],
	context: PluginContext,
	tiers: ToolTierTable,
): Promise<Registry> {
	const registry = emptyRegistry();
	const services = new Names("service");
	const sessionTools = new Names("session tool");
	const holds = new Names("hold rule");
	for (const plugin of plugins) {
		let contribution: Contribution;
		try {
			contribution = await plugin.setup(context);
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
		checkKeys(plugin.name, contribution);
		const {
			events,
			interactions = [],
			http = [],
			holdRules = [],
			piPackages = [],
			channels = [],
			dashboard = [],
			tools = [],
			seeds = [],
			prompt = [],
		} = contribution;
		const parts = [
			contribution.services ?? [],
			interactions,
			http,
			holdRules,
			piPackages,
			contribution.sessionTools ?? [],
			channels,
			dashboard,
			tools,
			seeds,
			prompt,
			contribution.agentSelection ? [contribution.agentSelection] : [],
		];
		const declares =
			(plugin.migrations?.length ?? 0) > 0 ||
			Object.keys(plugin.providers ?? {}).length > 0 ||
			plugin.preflight !== undefined ||
			plugin.useCommands !== undefined ||
			plugin.agentServer !== undefined ||
			plugin.stopTurn !== undefined;
		if (!declares && !events && parts.every((part) => part.length === 0))
			throw new PluginError(
				`plugin ${plugin.name} adds nothing. Give it a part (tools, services, channels, and so on), a migration, or a provider, or remove it.`,
			);
		for (const service of contribution.services ?? []) {
			services.claim(plugin.name, service.name);
			registry.services.push(service);
		}
		for (const rule of holdRules) holds.claim(plugin.name, rule.name);
		for (const tool of contribution.sessionTools ?? []) {
			sessionTools.claim(plugin.name, tool.name);
			registry.sessionTools.push(tool);
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
		registry.interactions.push(...interactions);
		registry.routes.push(...http);
		registry.holdRules.push(...holdRules);
		registry.piPackages.push(...piPackages);
		registry.channels.push(...channels);
		registry.dashboard.push(...dashboard);
		registry.seeds.push(...seeds);
		registry.prompt.push(...prompt);
	}
	return registry;
}

/** Links the collected session parts; throws PluginError on a clash. */
export function linkSessions(registry: Registry): LinkedSessions {
	return {
		holds: holdChain(registry.holdRules),
		// A package two plugins ask for loads once, where it was first asked for.
		piPackages: [...new Set(registry.piPackages)],
		plan: compileSessionPlan(registry.sessionTools),
		seeds: registry.seeds,
		prompt: registry.prompt,
		agentTools: registry.tools.filter((t) => t.agent).map((t) => t.name),
		agentSelection: () => mergeSelections(registry.agentSelections),
	};
}
