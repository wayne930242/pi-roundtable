import type { AgentTeam } from "pi-roundtable";
import { MAX_HELPER_PRESETS } from "pi-roundtable";
import type { CharacterInput } from "pi-roundtable/characters";
import type {
	PresetSaved,
	PresetsOverview,
	PresetsView,
	PresetTransferred,
	PresetView,
} from "../api-types.ts";
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
	| "presets"
	| "usablePresets"
	| "savePreset"
	| "deletePreset"
	| "allPresets"
	| "transferPreset"
>;

/** `GET api/presets`, for owners: every knight's presets with who recruited from them. */
export async function allPresetsRoute(
	owner: () => Promise<unknown>,
	team: Pick<PresetTeam, "allPresets">,
): Promise<Response> {
	await owner();
	return json({
		presets: await team.allPresets(),
		max: MAX_HELPER_PRESETS,
	} satisfies PresetsOverview);
}

/**
 * `api/agents/<name>/presets[/<preset>]`, for owners: a knight's temp-knight presets listed with
 * those shared with it, saved whole with whom they are shared, deleted, and given to another
 * knight with `POST …/<preset>/transfer`. The team checks them as `helper_preset_set` does, at the owner's tier; a
 * refusal comes back as a 400 with its words.
 */
export async function presetRoutes(
	request: Request,
	agent: string,
	[preset, verb]: string[],
	team: PresetTeam,
): Promise<Response> {
	const { method } = request;
	if (preset && verb === "transfer" && method === "POST") {
		const to = requiredText(await bodyOf(request), "to");
		return json({
			preset: await team.transferPreset(agent, preset, to),
		} satisfies PresetTransferred);
	}
	if (verb !== undefined) throw new HttpError(404, "There is no such API.");
	if (!preset && method === "GET")
		return json({
			presets: await team.presets(agent),
			shared: (await team.usablePresets(agent)).filter(
				(one) => one.agent !== agent,
			),
			max: MAX_HELPER_PRESETS,
		} satisfies PresetsView);
	if (preset && method === "PUT") {
		const body = await bodyOf(request);
		const sharing = sharingOf(body);
		const saved = await team.savePreset(
			agent,
			{ name: preset, ...presetFields(body) },
			...(sharing === undefined ? [] : [sharing]),
		);
		return json(saved satisfies PresetSaved);
	}
	if (preset && method === "DELETE") {
		if (!(await team.deletePreset(agent, preset)))
			throw new HttpError(404, `There is no preset "${preset}".`);
		return new Response(null, { status: 204 });
	}
	throw new HttpError(404, "There is no such API.");
}

/** The body's sharing: `"all"`, a list of knights, `null` for none, or undefined to keep it. */
function sharingOf(
	body: Record<string, unknown>,
): "all" | string[] | null | undefined {
	const { sharedWith } = body;
	if (sharedWith === null || sharedWith === "all") return sharedWith;
	return optionalList(body, "sharedWith");
}

/** The body's fields of a preset; the team checks what they say. */
function presetFields(
	body: Record<string, unknown>,
): Omit<PresetView, "name" | "sharedWith"> {
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
