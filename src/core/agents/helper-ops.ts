import type { Agent } from "./agent-rules.ts";
import type { HelperPreset } from "./helper-presets.ts";

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
	 * A knight's temp-knight presets, by name, as an owner manages them outside any agent turn.
	 * These three throw AgentError when temp knights are off, for an unknown or archived agent,
	 * and for a temp knight, which keeps none.
	 */
	presets(agent: string): Promise<HelperPreset[]>;
	/**
	 * Saves a preset whole under its name, with `helper_preset_set`'s checks at the owner's tier;
	 * refuses a new one past 20. Returns the preset as saved and whether it replaced one.
	 */
	savePreset(
		agent: string,
		preset: HelperPreset,
	): Promise<{ preset: HelperPreset; replaced: boolean }>;
	/** Deletes one of a knight's presets; says whether there was one. */
	deletePreset(agent: string, name: string): Promise<boolean>;
}
