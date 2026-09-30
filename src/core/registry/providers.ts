import type { Judge, Providers } from "../contract/providers.ts";
import { PluginError, ProviderError } from "../errors.ts";
import { type JudgeModel, ModelJudge } from "../judging/model-judge.ts";
import type { RoundtablePlugin } from "../plugin.ts";

const SLOTS = [
	"judge",
	"images",
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
				"no image provider is configured; agents keep the neutral avatar",
			);
		},
	};
}

/** Each slot from the one plugin that fills it, else the core's default; two plugins filling one slot clash. */
export function resolveProviders(
	plugins: readonly RoundtablePlugin[],
	judgeModel?: JudgeModel,
): Providers {
	const resolved = defaults(judgeModel);
	const filledBy = new Map<keyof Providers, string>();
	for (const plugin of plugins) {
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
	return resolved;
}
