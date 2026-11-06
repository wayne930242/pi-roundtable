import type { Agent } from "./agent-rules.ts";
import type {
	HelperPreset,
	OwnedPreset,
	PresetOverview,
	PresetSharing,
	UsablePreset,
} from "./helper-presets.ts";

/** A knight cleared its own temp knights with `helper_end`. */
export interface HelpersEnded {
	/** The knight that ended them. */
	parent: string;
	/** The temp knights archived, by name. */
	names: string[];
}

/** What the agent team offers for temp knights: the helpers a knight made for a task. */
export interface HelperTeam {
	/** The active temp knights a knight made, in the order they were made. */
	helpersOf(parent: string): Agent[];
	/**
	 * The active temp knights that are finished (nothing runs, queued or waits for the owner), of
	 * the named parents or, with none named, of every knight.
	 */
	finishedHelpers(parents?: readonly string[]): Agent[];
	/**
	 * Archives temp knights like `archive`, each keeping its history, and closes their Discord
	 * threads; a name that is no active temp knight is passed over. `by` is who asks, for the log.
	 * Says which were archived.
	 */
	archiveHelpers(names: readonly string[], by: string): Promise<string[]>;
	/**
	 * Restores archived temp knights, the undo of `archiveHelpers`: only a name that is still an
	 * archived temp knight of an active parent is restored. Says which were.
	 */
	restoreHelpers(names: readonly string[]): Promise<string[]>;
	/** Called when a knight clears its own temp knights with `helper_end`; not for an owner's or the host's clearing. */
	onHelpersEnded(listener: (event: HelpersEnded) => void): void;
	/** Whether the host makes temp knights at all: false under `helpers: false`. */
	helpersOn(): boolean;
	/**
	 * A knight's temp-knight presets, by name, with whom each is shared, as an owner manages them
	 * outside any agent turn. These four throw AgentError when temp knights are off, for an unknown
	 * or archived agent, and for a temp knight, which keeps none.
	 */
	presets(agent: string): Promise<OwnedPreset[]>;
	/**
	 * What a knight may recruit its temp knights from: its own presets, then those other active
	 * knights share with it, each with the agent that saved it.
	 */
	usablePresets(agent: string): Promise<UsablePreset[]>;
	/**
	 * Saves a preset whole under its name, with `helper_preset_set`'s checks at the owner's tier;
	 * refuses a new one past 20. `sharedWith` sets who else may recruit from it: every knight,
	 * the knights named, or `null` none; left out, a replaced preset keeps its sharing and a new
	 * one is shared with none. Returns the preset as saved and whether it replaced one.
	 */
	savePreset(
		agent: string,
		preset: HelperPreset,
		sharedWith?: PresetSharing | null,
	): Promise<{ preset: OwnedPreset; replaced: boolean }>;
	/** Deletes one of a knight's presets; says whether there was one. */
	deletePreset(agent: string, name: string): Promise<boolean>;
	/**
	 * Every preset of every active knight, by knight and then name, each with whom it is shared and
	 * the knights that recruited temp knights from it. Throws AgentError when temp knights are off.
	 */
	allPresets(): Promise<PresetOverview[]>;
	/**
	 * Moves a knight's preset to another active knight that is no temp knight, keeping its content
	 * and sharing: `to` leaves the shared list, and the old owner joins it unless the preset is
	 * shared with every knight. Refuses the same knight, a name `to` already has, `to` at 20
	 * presets, and an unknown preset. Temp knights made from it keep the name they recorded.
	 */
	transferPreset(agent: string, name: string, to: string): Promise<OwnedPreset>;
}
