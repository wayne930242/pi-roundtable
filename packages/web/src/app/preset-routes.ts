import type { AgentTeam } from "pi-roundtable";
import { MAX_HELPER_PRESETS } from "pi-roundtable";
import type { CharacterInput } from "pi-roundtable/characters";
import type { PresetSaved, PresetsView, PresetView } from "../api-types.ts";
import { json } from "../http.ts";
import {
	bad,
	bodyOf,
	HttpError,
	optionalList,
	optionalText,
	requiredText,
} from "./api-http.ts";

/** What the preset routes ask of the team. */
export type PresetTeam = Pick<
	AgentTeam,
	"presets" | "savePreset" | "deletePreset"
>;

/**
 * `api/agents/<name>/presets[/<preset>]`, for owners: a knight's temp-knight presets listed, saved
 * whole, and deleted. The team checks them as `helper_preset_set` does, at the owner's tier; a
 * refusal comes back as a 400 with its words.
 */
export async function presetRoutes(
	request: Request,
	agent: string,
	preset: string | undefined,
	team: PresetTeam,
): Promise<Response> {
	const { method } = request;
	if (!preset && method === "GET")
		return json({
			presets: await team.presets(agent),
			max: MAX_HELPER_PRESETS,
		} satisfies PresetsView);
	if (preset && method === "PUT") {
		const saved = await team.savePreset(agent, {
			name: preset,
			...presetFields(await bodyOf(request)),
		});
		return json(saved satisfies PresetSaved);
	}
	if (preset && method === "DELETE") {
		if (!(await team.deletePreset(agent, preset)))
			throw new HttpError(404, `There is no preset "${preset}".`);
		return new Response(null, { status: 204 });
	}
	throw new HttpError(404, "There is no such API.");
}

/** The body's fields of a preset; the team checks what they say. */
function presetFields(body: Record<string, unknown>): Omit<PresetView, "name"> {
	const model = optionalText(body, "model");
	const thinking = optionalText(body, "thinking");
	const { character } = body;
	if (
		character !== undefined &&
		(typeof character !== "object" ||
			character === null ||
			Array.isArray(character))
	)
		throw bad("character must be an object.");
	return {
		displayName: requiredText(body, "displayName"),
		prompt: requiredText(body, "prompt"),
		skills: optionalList(body, "skills") ?? [],
		...(character ? { character: character as CharacterInput } : {}),
		...(model ? { model } : {}),
		...(thinking ? { thinking } : {}),
	};
}
