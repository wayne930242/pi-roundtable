import { AgentError } from "../domain/errors.ts";
import { isHelper } from "./agent-rules.ts";
import type {
	OwnedPreset,
	PresetSharing,
	UsablePreset,
} from "./helper-presets.ts";
import type { TeamContext } from "./team-options.ts";

/** A preset found for a knight, with the name its temp knight records: `<agent>/<name>` for a shared one. */
export interface FoundPreset {
	preset: OwnedPreset;
	ref: string;
}

const refOf = (agent: string, preset: UsablePreset): string =>
	preset.agent === agent ? preset.name : `${preset.agent}/${preset.name}`;

/** The presets others share with the knight, of agents still active. */
export async function sharedPresets(
	ctx: TeamContext,
	agent: string,
): Promise<UsablePreset[]> {
	const { store } = ctx.options;
	const shared = await store.presets.sharedWith(agent);
	return shared.filter((p) => store.agent(p.agent)?.status === "active");
}

/** What a knight may recruit from: its own presets first, then those shared with it. */
export async function usablePresets(
	ctx: TeamContext,
	agent: string,
): Promise<UsablePreset[]> {
	const own = await ctx.options.store.presets.list(agent);
	return [
		...own.map((preset) => ({ ...preset, agent })),
		...(await sharedPresets(ctx, agent)),
	];
}

/**
 * The preset a knight names: its own, `<agent>/<name>` shared with it, or a bare name one shared
 * preset alone has. Its own wins over a shared one; a bare name several share is refused with
 * their qualified names, and an unknown one with the names the knight may use.
 */
export async function findPreset(
	ctx: TeamContext,
	agent: string,
	ref: string,
): Promise<FoundPreset> {
	const slash = ref.indexOf("/");
	const owner = slash < 0 ? agent : ref.slice(0, slash);
	const name = slash < 0 ? ref : ref.slice(slash + 1);
	if (owner === agent) {
		const own = await ctx.options.store.presets.get(agent, name);
		if (own) return { preset: own, ref: name };
	}
	const shared = await sharedPresets(ctx, agent);
	const matches = shared.filter(
		(p) => p.name === name && (slash < 0 || p.agent === owner),
	);
	const [only] = matches;
	if (only && matches.length === 1) {
		const { agent: _agent, ...preset } = only;
		return { preset, ref: refOf(agent, only) };
	}
	if (matches.length > 1)
		throw new AgentError(
			`Several knights share a preset "${name}"; name one of ${matches.map((p) => refOf(agent, p)).join(", ")}.`,
		);
	const names = (await usablePresets(ctx, agent)).map((p) => refOf(agent, p));
	throw new AgentError(
		names.length > 0
			? `You have no preset "${ref}". Your presets: ${names.join(", ")}.`
			: `You have no preset "${ref}", nor any other; save one with helper_preset_set.`,
	);
}

/**
 * The sharing as it is saved, or AgentError: the knights named must be existing knights, not temp
 * knights; the preset's own agent is dropped from the list, and an empty list shares with none.
 */
export function checkSharing(
	ctx: TeamContext,
	agent: string,
	sharing: PresetSharing | null | undefined,
): PresetSharing | null | undefined {
	if (sharing === undefined || sharing === null || sharing === "all")
		return sharing;
	const { store } = ctx.options;
	const names = [...new Set(sharing)].filter((name) => name !== agent);
	const unknown = names.filter((name) => {
		const known = store.agent(name);
		return !known || isHelper(known);
	});
	if (unknown.length > 0)
		throw new AgentError(
			`A preset can be shared only with knights; not one: ${unknown.join(", ")}.`,
		);
	return names.length > 0 ? names : null;
}

/** One line of `helper_preset_list`: a shared preset by its qualified name and its agent. */
export function presetLine(agent: string, preset: UsablePreset): string {
	const prompt = preset.prompt.replace(/\s+/g, " ").trim();
	const head = prompt.length > 80 ? `${prompt.slice(0, 80)}…` : prompt;
	const extras = [
		preset.skills.length > 0 ? `skills: ${preset.skills.join(", ")}` : "",
		preset.model ? `model: ${preset.model}` : "",
	].filter(Boolean);
	const by = preset.agent === agent ? "" : ` [shared by ${preset.agent}]`;
	return `${refOf(agent, preset)}${by}: "${preset.displayName}"${extras.length > 0 ? ` (${extras.join("; ")})` : ""}: ${head}`;
}

/** A preset in full, as `helper_preset_list` with a name shows it. */
export function presetText(found: FoundPreset): string {
	const { preset, ref } = found;
	const slash = ref.indexOf("/");
	return [
		`Preset "${ref}"${slash < 0 ? "" : ` (shared by ${ref.slice(0, slash)})`}`,
		`Display name: ${preset.displayName}`,
		`Skills: ${preset.skills.length > 0 ? preset.skills.join(", ") : "none"}`,
		...(preset.character?.class ? [`Class: ${preset.character.class}`] : []),
		...(preset.character?.palette
			? [`Color: ${preset.character.palette}`]
			: []),
		...(preset.model ? [`Model: ${preset.model}`] : []),
		...(preset.thinking ? [`Thinking: ${preset.thinking}`] : []),
		`Prompt:\n${preset.prompt}`,
	].join("\n");
}
