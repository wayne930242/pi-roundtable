import { type HeldCall, SYSTEM_PRINCIPAL } from "pi-roundtable";
import {
	type PromptSlot,
	workTimeout,
	YOLO_CARDED_SHELL_CLASSES,
	YOLO_NEVER_CLASS,
} from "pi-roundtable/kit";
import type { CodingDeskOptions, CodingJob } from "./desk-types.ts";
import { checkTime } from "./limits.ts";

const DEFAULT_TIMEOUT_MS = 3_600_000;
/** The core's default long-running ceiling, four hours. */
const DEFAULT_LONG_RUNNING_MS = 4 * 60 * 60_000;
/** How often a run past its own limit looks again at the starter's long-running mode. */
const LONG_RUNNING_STEP_MS = 60_000;

/** The rule a class belongs to: the part before its first dot, or a rule's bare name. */
function ruleOf(id: string): string {
	const dot = id.indexOf(".");
	return dot === -1 ? id : id.slice(0, dot);
}

/** What a job's starter's yolo and long-running modes allow its worker, read live. */
export class DeskModes {
	readonly #options: CodingDeskOptions;
	readonly #longRunningMs: number;
	readonly #yoloApproves: (id: string) => boolean;
	constructor(options: CodingDeskOptions) {
		checkTime("timeoutMs", options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
		const longRunning =
			options.autonomy?.longRunningMaxMs ?? DEFAULT_LONG_RUNNING_MS;
		checkTime("autonomy.longRunningMaxMs", longRunning);
		this.#longRunningMs = longRunning;
		const allow = new Set(options.autonomy?.yolo?.allow ?? []);
		const card = new Set(options.autonomy?.yolo?.card ?? []);
		const carded = new Set<string>(YOLO_CARDED_SHELL_CLASSES);
		// The core's yolo rules: a carded class or rule never, an unclassed call only by its rule's name.
		this.#yoloApproves = (id) => {
			if (id.endsWith(`.${YOLO_NEVER_CLASS}`)) return false;
			if (card.has(id) || card.has(ruleOf(id))) return false;
			if (!id.includes(".")) return allow.has(id);
			return !carded.has(id) || allow.has(id);
		};
		this.#options = options;
	}
	/** Whether the starter's modes may act: only for an owner other than the host's own principal. */
	#modeOf(job: CodingJob): { yolo: boolean; longRunning: boolean } {
		const { modes } = this.#options;
		const speaker = job.starter?.speaker;
		if (
			!modes ||
			!job.starter ||
			speaker?.tier !== "owner" ||
			speaker.principalId === SYSTEM_PRINCIPAL
		)
			return { yolo: false, longRunning: false };
		const mode = modes.peek(job.starter.channel);
		return { yolo: mode.yolo === true, longRunning: mode.longRunning === true };
	}
	/** Whether the starter's yolo mode approves the call now, as it would in that conversation. */
	yolo(job: CodingJob, call: HeldCall): boolean {
		if (!this.#modeOf(job).yolo || call.approverIds !== undefined) return false;
		const classes = call.holdClasses;
		if (!classes?.length || !classes.every(this.#yoloApproves)) return false;
		const { starter } = job;
		if (!starter) return false;
		try {
			this.#options.modes?.autoApproved?.({
				channel: starter.channel,
				tool: call.tool,
				action: `coding #${job.id} in ${job.repo}: ${call.action}`,
				classes: [...classes],
				principalId: starter.speaker.principalId,
				at: new Date(),
			});
		} catch {
			this.#options.logger.warn(
				{ job: job.id },
				"Recording a yolo approval failed.",
			);
		}
		return true;
	}
	/**
	 * The worker's work-time budget: `timeoutMs`, then, while the starter's long-running mode is
	 * on, further steps up to `autonomy.longRunningMaxMs` in all. Card waits never count.
	 */
	budget(
		job: CodingJob,
		slot: PromptSlot,
		expire: (workedMs: number) => void,
	): () => void {
		const base = this.#options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		let worked = 0;
		let cancel = () => {};
		const phase = (ms: number) => {
			cancel = workTimeout(ms, slot, () => {
				worked += ms;
				if (this.#modeOf(job).longRunning && worked < this.#longRunningMs)
					phase(Math.min(LONG_RUNNING_STEP_MS, this.#longRunningMs - worked));
				else expire(worked);
			});
		};
		phase(base);
		return () => cancel();
	}
}
