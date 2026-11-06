import type { CharacterInput } from "../../characters/index.ts";
import { helpersOf, type ResolvedHelpers } from "../config/helpers.ts";
import { AgentError } from "../domain/errors.ts";
import { THINKING_LEVELS } from "../domain/models.ts";
import type { AgentTurnScope } from "../domain/ports.ts";
import type { Speaker, Tier } from "../identity/speakers.ts";
import { toolTiers } from "../runtime/tool-tiers.ts";
import {
	type Agent,
	checkDisplayName,
	checkModelRef,
	checkPrompt,
	isHelper,
} from "./agent-rules.ts";
import type { HelperPreset } from "./helper-presets.ts";
import type { TeamContext } from "./team-options.ts";

/** What the helper_preset tools ask of the team. */
export type PresetAction =
	| { kind: "set"; preset: HelperPreset }
	| { kind: "list"; name?: string }
	| { kind: "delete"; name: string };

/** What a temp knight is made with; a preset fills in what the call leaves out. */
export interface HelperFields {
	preset?: string;
	displayName?: string;
	prompt?: string;
	character?: CharacterInput;
	skills?: string[];
	model?: string;
	thinking?: string;
}

const PRESET_NAME = /^[a-z0-9-]{1,32}$/;

/**
 * The speaker of the caller's turn and the knight it is, refused when temp knights are off, outside
 * an agent turn, or for a temp knight, which cannot make temp knights.
 */
export function helperMaker(
	ctx: TeamContext,
	caller: AgentTurnScope,
	tool: string,
): { speaker: Speaker; parent: Agent; limits: ResolvedHelpers } {
	const limits = helpersOf(ctx.options.helpers);
	if (!limits)
		throw new AgentError("Temp knights are switched off on this host.");
	const speaker = ctx.turns.speakerOf(caller);
	if (!speaker)
		throw new AgentError(`${tool} can only be used during an agent turn.`);
	const parent = ctx.options.store.activeAgent(caller.name);
	if (isHelper(parent))
		throw new AgentError(
			`You are a temp knight of "${parent.parent}" and cannot make temp knights; ask it to.`,
		);
	return { speaker, parent, limits };
}

/**
 * A temp knight never gets more than its parent unless the speaker could grant it by hand: another
 * model or thinking level needs the agent_update tier, a skill the parent does not carry the
 * agent_skills tier.
 */
export function checkHelperGrant(
	ctx: TeamContext,
	tier: Tier,
	parent: Agent,
	fields: Pick<HelperFields, "model" | "thinking" | "skills">,
): void {
	const tiers = ctx.options.toolTiers ?? toolTiers();
	if (!tiers.allows(tier, "agent_update") && (fields.model || fields.thinking))
		throw new AgentError(
			"A temp knight runs your model and thinking level; choosing others needs a higher tier.",
		);
	if (fields.skills?.length && !tiers.allows(tier, "agent_skills")) {
		const own = new Set(ctx.options.skills?.carriedNames(parent.name) ?? []);
		const extra = fields.skills.filter((skill) => !own.has(skill));
		if (extra.length > 0)
			throw new AgentError(
				`A temp knight can carry only skills you carry; not allowed: ${extra.join(", ")}.`,
			);
	}
}

/**
 * The call's fields over the named preset: what the call gives replaces the preset's, and its
 * skills are added after the preset's. An unknown preset is refused with the caller's names.
 */
export async function withPreset<T extends HelperFields>(
	ctx: TeamContext,
	parent: Agent,
	input: T,
): Promise<T> {
	const { preset: name, ...given } = input;
	if (!name) return input;
	const presets = ctx.options.store.presets;
	const preset = await presets.get(parent.name, name);
	if (!preset) {
		const names = (await presets.list(parent.name)).map((p) => p.name);
		throw new AgentError(
			names.length > 0
				? `You have no preset "${name}". Your presets: ${names.join(", ")}.`
				: `You have no preset "${name}", nor any other; save one with helper_preset_set.`,
		);
	}
	const skills = [...new Set([...preset.skills, ...(given.skills ?? [])])];
	const character = { ...preset.character, ...given.character };
	return {
		...given,
		displayName: given.displayName ?? preset.displayName,
		prompt: given.prompt ?? preset.prompt,
		...(Object.keys(character).length > 0 ? { character } : {}),
		...(skills.length > 0 ? { skills } : {}),
		...((given.model ?? preset.model)
			? { model: given.model ?? preset.model }
			: {}),
		...((given.thinking ?? preset.thinking)
			? { thinking: given.thinking ?? preset.thinking }
			: {}),
	} as T;
}

/** The helper_preset tools: an agent saves, lists, and deletes its own temp-knight presets. */
export async function presetAction(
	ctx: TeamContext,
	caller: AgentTurnScope,
	action: PresetAction,
): Promise<string> {
	const tool = `helper_preset_${action.kind}`;
	const { speaker, parent } = helperMaker(ctx, caller, tool);
	const presets = ctx.options.store.presets;
	if (action.kind === "set") {
		const preset = validatePreset(ctx, speaker.tier, parent, action.preset);
		const done = await presets.set(parent.name, preset);
		return `${done === "created" ? "Created" : "Replaced"} the preset "${preset.name}"; make its temp knight with helper_create and preset "${preset.name}".`;
	}
	if (action.kind === "delete") {
		if (!(await presets.delete(parent.name, action.name)))
			throw new AgentError(`You have no preset "${action.name}".`);
		return `Deleted the preset "${action.name}".`;
	}
	if (action.name) {
		const preset = await presets.get(parent.name, action.name);
		if (!preset) throw new AgentError(`You have no preset "${action.name}".`);
		return presetText(preset);
	}
	const all = await presets.list(parent.name);
	if (all.length === 0)
		return "You have no presets; save one with helper_preset_set.";
	return all.map(presetLine).join("\n");
}

/**
 * The preset as it is saved, its skills deduplicated, or AgentError: the checks a temp knight's
 * fields get when it is made, and what a speaker of `tier` may grant beyond the parent's own.
 * The store holds the cap of presets as it saves.
 */
export function validatePreset(
	ctx: TeamContext,
	tier: Tier,
	parent: Agent,
	given: HelperPreset,
): HelperPreset {
	const preset = { ...given, skills: [...new Set(given.skills)] };
	if (!PRESET_NAME.test(preset.name))
		throw new AgentError(
			`"${preset.name}" is not a preset name: use 1 to 32 lowercase letters, digits, and dashes.`,
		);
	checkDisplayName(preset.displayName);
	checkPrompt(preset.prompt);
	if (preset.model) checkModelRef(preset.model);
	if (
		preset.thinking &&
		![...THINKING_LEVELS, "default"].includes(preset.thinking as never)
	)
		throw new AgentError(
			`"${preset.thinking}" is not a thinking level; use one of ${THINKING_LEVELS.join(", ")}, or default.`,
		);
	if (preset.skills.length > 0) {
		const registry = ctx.options.skills;
		if (!registry)
			throw new AgentError(
				"Skills are off on this host, so a preset cannot carry any. Save it without skills.",
			);
		registry.checkRegistered(preset.skills);
	}
	checkHelperGrant(ctx, tier, parent, preset);
	return preset;
}

/**
 * The knight whose presets an owner manages from outside any agent turn: refused when temp knights
 * are off, for an unknown or archived agent, and for a temp knight, which keeps none.
 */
function presetOwner(ctx: TeamContext, name: string): Agent {
	if (!helpersOf(ctx.options.helpers))
		throw new AgentError("Temp knights are switched off on this host.");
	const agent = ctx.options.store.activeAgent(name);
	if (isHelper(agent))
		throw new AgentError(`"${name}" is a temp knight and keeps no presets.`);
	return agent;
}

/** An owner's handling of a knight's presets, at the owner's tier; see `HelperTeam.presets`. */
export const ownerPresets = (ctx: TeamContext) => ({
	list: async (agent: string): Promise<HelperPreset[]> =>
		ctx.options.store.presets.list(presetOwner(ctx, agent).name),
	save: async (agent: string, given: HelperPreset) => {
		const parent = presetOwner(ctx, agent);
		const preset = validatePreset(ctx, "owner", parent, given);
		const done = await ctx.options.store.presets.set(parent.name, preset);
		return { preset, replaced: done === "replaced" };
	},
	delete: async (agent: string, name: string): Promise<boolean> =>
		ctx.options.store.presets.delete(presetOwner(ctx, agent).name, name),
});

const presetLine = (preset: HelperPreset): string => {
	const prompt = preset.prompt.replace(/\s+/g, " ").trim();
	const head = prompt.length > 80 ? `${prompt.slice(0, 80)}…` : prompt;
	const extras = [
		preset.skills.length > 0 ? `skills: ${preset.skills.join(", ")}` : "",
		preset.model ? `model: ${preset.model}` : "",
	].filter(Boolean);
	return `${preset.name}: "${preset.displayName}"${extras.length > 0 ? ` (${extras.join("; ")})` : ""}: ${head}`;
};

const presetText = (preset: HelperPreset): string =>
	[
		`Preset "${preset.name}"`,
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
