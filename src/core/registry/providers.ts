import type {
	Judge,
	Providers,
	ResolvedProviders,
} from "../contract/providers.ts";
import { PluginError, ProviderError } from "../errors.ts";
import { type JudgeModel, ModelJudge } from "../judging/model-judge.ts";
import type { RoundtablePlugin } from "../plugin.ts";
import { nearest } from "./contributions.ts";

const SLOTS = [
	"judge",
	"images",
	"runtime",
] as const satisfies readonly (keyof Providers)[];

/** A judge with no model: every question throws, so each caller keeps its own default. */
const unconfiguredJudge = (): Judge => {
	const refuse = async (): Promise<never> => {
		throw new ProviderError(
			"no judge is configured: provide one or give the host a judge model",
		);
	};
	return { askYesNo: refuse, askChoice: refuse, askScore: refuse };
};

/** The core's own providers, for the slots no plugin fills. */
function defaults(judgeModel: JudgeModel | undefined): Providers {
	return {
		judge: judgeModel ? new ModelJudge(judgeModel) : unconfiguredJudge(),
		images: async () => {
			throw new ProviderError(
				"no image provider is configured; agents use generated avatars",
			);
		},
		runtime: () => {
			throw new ProviderError(
				"no runtime provider is configured: the agent server builds the Pi runtime when no plugin fills the runtime slot",
			);
		},
	};
}

/** Refuses a provider slot the contract does not have, naming the nearest one and the valid ones. */
function checkSlots(plugin: RoundtablePlugin): void {
	for (const slot of Object.keys(plugin.providers ?? {})) {
		if ((SLOTS as readonly string[]).includes(slot)) continue;
		const meant = nearest(slot, SLOTS);
		throw new PluginError(
			`plugin ${plugin.name}: unknown provider slot "${slot}".${
				meant ? ` Did you mean "${meant}"?` : ""
			} The slots are ${SLOTS.join(", ")}.`,
		);
	}
}

/** Each slot from the one plugin that fills it, else the core's default; two plugins filling one slot clash. */
export function resolveProviders(
	plugins: readonly RoundtablePlugin[],
	judgeModel?: JudgeModel,
): ResolvedProviders {
	const resolved: Providers = defaults(judgeModel);
	const filledBy = new Map<keyof Providers, string>();
	for (const plugin of plugins) {
		checkSlots(plugin);
		for (const slot of SLOTS) {
			const provided = plugin.providers?.[slot];
			if (!provided) continue;
			const other = filledBy.get(slot);
			if (other)
				throw new PluginError(
					`plugin ${plugin.name}: provider slot ${slot} is already filled by plugin ${other}. Keep one plugin that fills it.`,
				);
			filledBy.set(slot, plugin.name);
			// One key of a Providers, so the slot and its provider agree.
			Object.assign(resolved, { [slot]: provided });
		}
	}
	return { ...resolved, filled: new Set(filledBy.keys()) };
}

/** Whether a plugin fills the `images` slot, so agents can be offered drawing before any host runs. */
export function fillsImages(plugins: readonly RoundtablePlugin[]): boolean {
	return plugins.some((plugin) => Boolean(plugin.providers?.images));
}
