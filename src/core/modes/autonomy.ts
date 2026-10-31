/** How far the host lets a conversation run without a person: the limits behind its modes. */
export interface Autonomy {
	yolo: {
		/**
		 * Hold classes yolo may approve although it cards them by default, such as `shell.rm`, and the
		 * names of rules that report no classes, such as `tool:repo_push`, whose calls it then approves.
		 */
		allow: readonly string[];
		/** Hold classes or rule names yolo never approves, such as `shell.push` or `tool:repo_push`. */
		card: readonly string[];
		/**
		 * How long an `ask_user` card holds a yolo turn before it goes on with its own best choice, in
		 * ms; the card stays open. Default `DEFAULT_YOLO_QUESTION_GRACE_MS`, 30 seconds.
		 */
		questionGraceMs?: number;
		/**
		 * How long the timeout card waits in a yolo conversation before the turn goes on as if
		 * Continue were pressed, in ms. Default `DEFAULT_YOLO_TIMEOUT_CARD_GRACE_MS`, one minute.
		 */
		timeoutCardGraceMs?: number;
	};
	/** The most one long-running turn works in all before it asks or stops, in ms. */
	longRunningMaxMs: number;
}

/** The longest a long-running turn works without a person: four hours. */
export const DEFAULT_LONG_RUNNING_MS = 4 * 60 * 60_000;

/** How long a yolo turn waits on its `ask_user` card before it goes on: 30 seconds. */
export const DEFAULT_YOLO_QUESTION_GRACE_MS = 30_000;

/** How long a yolo turn's timeout card waits before the turn goes on by itself: one minute. */
export const DEFAULT_YOLO_TIMEOUT_CARD_GRACE_MS = 60_000;

/** Yolo approves nothing beyond its built-in classes, and a long-running turn stops at four hours. */
export const DEFAULT_AUTONOMY: Autonomy = Object.freeze({
	yolo: Object.freeze({
		allow: [],
		card: [],
		questionGraceMs: DEFAULT_YOLO_QUESTION_GRACE_MS,
		timeoutCardGraceMs: DEFAULT_YOLO_TIMEOUT_CARD_GRACE_MS,
	}),
	longRunningMaxMs: DEFAULT_LONG_RUNNING_MS,
});
