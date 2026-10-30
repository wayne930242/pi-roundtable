import type { Agent } from "./agent-rules.ts";

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
}
