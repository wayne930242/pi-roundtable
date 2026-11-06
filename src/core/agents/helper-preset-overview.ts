import { helpersOf } from "../config/helpers.ts";
import { AgentError } from "../domain/errors.ts";
import { isHelper } from "./agent-rules.ts";
import { presetOwner } from "./helper-preset-ops.ts";
import type {
	OwnedPreset,
	PresetOverview,
	PresetRecruits,
} from "./helper-presets.ts";
import type { TeamContext } from "./team-options.ts";

/**
 * Every preset of an active knight, with the knights that recruited from it: a temp knight
 * records its own parent's preset by name and another's as `<agent>/<name>`.
 */
export async function allPresets(ctx: TeamContext): Promise<PresetOverview[]> {
	if (!helpersOf(ctx.options.helpers))
		throw new AgentError("Temp knights are switched off on this host.");
	const { store } = ctx.options;
	const [presets, rows] = await Promise.all([
		store.presets.all(),
		store.presets.recruits(),
	]);
	const byPreset = new Map<string, Map<string, PresetRecruits>>();
	for (const row of rows) {
		const slash = row.preset.indexOf("/");
		const key = slash < 0 ? `${row.parent}/${row.preset}` : row.preset;
		const knights = byPreset.get(key) ?? new Map<string, PresetRecruits>();
		byPreset.set(key, knights);
		const seen = knights.get(row.parent) ?? {
			knight: row.parent,
			active: 0,
			archived: 0,
		};
		knights.set(row.parent, seen);
		seen[row.status] += row.count;
		const last = row.last?.toISOString();
		if (last && (!seen.last || last > seen.last)) seen.last = last;
	}
	return presets
		.filter((preset) => {
			const agent = store.agent(preset.agent);
			return agent?.status === "active" && !isHelper(agent);
		})
		.map((preset) => ({
			...preset,
			recruits: [
				...(byPreset.get(`${preset.agent}/${preset.name}`)?.values() ?? []),
			].sort((a, b) => a.knight.localeCompare(b.knight)),
		}));
}

/**
 * Moves a knight's preset to another active knight, keeping its content and sharing: the new
 * agent leaves the shared list, and the old one joins it unless the preset is shared with all.
 */
export async function transferPreset(
	ctx: TeamContext,
	agent: string,
	name: string,
	to: string,
): Promise<OwnedPreset> {
	const from = presetOwner(ctx, agent).name;
	if (to === from)
		throw new AgentError(`The preset "${name}" is already ${from}'s.`);
	const target = ctx.options.store.activeAgent(to);
	if (isHelper(target))
		throw new AgentError(`"${to}" is a temp knight and keeps no presets.`);
	const { presets } = ctx.options.store;
	const preset = await presets.get(from, name);
	if (!preset) throw new AgentError(`${from} has no preset "${name}".`);
	const shared = preset.sharedWith;
	const sharing =
		shared === "all"
			? ["*"]
			: [...new Set([...(shared ?? []), from])].filter((n) => n !== to);
	if (!(await presets.transfer(from, name, to, sharing)))
		throw new AgentError(`${from} has no preset "${name}".`);
	return (await presets.get(to, name)) ?? preset;
}
