/** How far the host lets a conversation run without a person: the limits behind its modes. */
export interface Autonomy {
	yolo: {
		/** Hold classes yolo may approve although it cards them by default, such as `shell.rm`. */
		allow: readonly string[];
		/** Hold classes or rule names yolo never approves, such as `shell.push` or `repo-push`. */
		card: readonly string[];
	};
	/** The most one long-running turn works in all before it asks or stops, in ms. */
	longRunningMaxMs: number;
}

/** The longest a long-running turn works without a person: four hours. */
export const DEFAULT_LONG_RUNNING_MS = 4 * 60 * 60_000;

/** Yolo approves nothing beyond its built-in classes, and a long-running turn stops at four hours. */
export const DEFAULT_AUTONOMY: Autonomy = Object.freeze({
	yolo: Object.freeze({ allow: [], card: [] }),
	longRunningMaxMs: DEFAULT_LONG_RUNNING_MS,
});
