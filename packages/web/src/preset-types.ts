// The API shapes of a knight's temp-knight presets, re-exported by `api-types.ts`.

import type { CharacterInput } from "pi-roundtable/characters";

/** One temp-knight preset: what its temp knight is made with, saved under a name. */
export interface PresetView {
	/** Fixed once saved: lowercase letters, digits and dashes, 1 to 32. */
	name: string;
	displayName: string;
	prompt: string;
	skills: string[];
	/** Fields of its temp knight's look; any left out come from the look its role suggests. */
	character?: CharacterInput;
	/** `<provider>/<model>`; absent runs the knight's own. */
	model?: string;
	/** Absent runs the knight's own thinking level. */
	thinking?: string;
	/** Who else may recruit from it: every knight, or the knights named; absent, only its knight. */
	sharedWith?: "all" | string[];
}

/** A preset another knight shares with this one, which only that knight or an owner changes. */
export interface SharedPresetView extends PresetView {
	/** The knight that saved it. */
	agent: string;
}

/**
 * `GET api/agents/<name>/presets`: the knight's presets by name, those other knights share with it,
 * and how many it may keep.
 */
export interface PresetsView {
	presets: PresetView[];
	shared: SharedPresetView[];
	max: number;
}

/**
 * The body of `PUT api/agents/<name>/presets/<preset>`: the preset whole, its name in the path.
 * `sharedWith` `null` shares it with none; left out, a replaced preset keeps its sharing.
 */
export type PresetSave = Omit<PresetView, "name" | "skills" | "sharedWith"> & {
	skills?: string[];
	sharedWith?: "all" | string[] | null;
};

/** The answer of the `PUT`: the preset as saved, and whether it replaced one of that name. */
export interface PresetSaved {
	preset: PresetView;
	replaced: boolean;
}
