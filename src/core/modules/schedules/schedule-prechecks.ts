import type { HoldCheck } from "../../holds.ts";
import type { Logger } from "../../log.ts";
import type { Tier } from "../../speakers.ts";
import { timeZone, zonedStamp } from "../../time.ts";
import { type PrecheckTool, precheckScriptTools } from "./precheck-tools.ts";
import {
	type Precheck,
	type PrecheckOutcome,
	type PrecheckRegistry,
	runPrecheck,
	SCRIPT_PRECHECK,
} from "./prechecks.ts";
import type { Schedule } from "./schedule-store.ts";

interface SchedulePrechecksOptions {
	/** The host's prechecks and script runner; without them, a schedule that has one runs with that as its error. */
	prechecks?: Pick<PrecheckRegistry, "get"> &
		Partial<Pick<PrecheckRegistry, "scriptRunner">>;
	/**
	 * The host's hold rules, read when a script saved before its tools were recorded runs: it runs
	 * only if it calls no held tool. Without them, such a script does not run.
	 */
	holds?: () => HoldCheck;
	logger: Logger;
	signal: AbortSignal;
}

/** Runs schedule prechecks and tracks underlying runs that outlive a timeout. */
export class SchedulePrechecks {
	readonly #options: SchedulePrechecksOptions;
	readonly #pending = new Set<Promise<unknown>>();

	constructor(options: SchedulePrechecksOptions) {
		this.#options = options;
	}

	/** Runs the schedule's precheck for a run at `tier`, its creator's capped tier now. */
	async run(
		schedule: Schedule,
		name: string,
		firedAt: Date,
		tier: Tier,
	): Promise<PrecheckOutcome> {
		const { logger } = this.#options;
		let decision: PrecheckOutcome;
		try {
			const precheck = this.#resolve(schedule, firedAt);
			decision =
				typeof precheck === "string"
					? { kind: "failed", error: precheck }
					: await runPrecheck(
							precheck,
							{ schedule, firedAt, tier },
							{
								signal: this.#options.signal,
								settled: (run) => {
									const tracked = run
										.catch(() => undefined)
										.finally(() => this.#pending.delete(tracked));
									this.#pending.add(tracked);
								},
							},
						);
		} catch (error) {
			decision = {
				kind: "failed",
				error: `the precheck could not be looked up: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
		// A warning, not an error: the woken turn carries the error already, and an error line would
		// wake the ops agent's report turn for the same failure.
		if (decision.kind === "failed")
			logger.warn(
				{ schedule: schedule.id, precheck: name, error: decision.error },
				"precheck failed; the scheduled turn runs with the error",
			);
		else
			logger.info(
				{
					schedule: schedule.id,
					precheck: name,
					wake: decision.kind === "wake",
				},
				"precheck decided",
			);
		return decision;
	}

	async drain(limitMs: number): Promise<void> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const limit = new Promise<"late">((resolve) => {
			timer = setTimeout(() => resolve("late"), limitMs);
		});
		const settled = Promise.allSettled([...this.#pending]);
		try {
			// pi-lens-ignore: no-single-promise-in-promise-methods — the race includes both all pending cleanup and the stop deadline
			if ((await Promise.race([settled, limit])) === "late")
				this.#options.logger.warn(
					{ prechecks: this.#pending.size },
					"prechecks still cleaning up when the scheduler stopped",
				);
		} finally {
			clearTimeout(timer);
		}
	}

	/**
	 * The schedule's precheck: a registered one by name, or its script through the host's runner.
	 * A script never runs in this process; without a runner it fails, and the turn still runs.
	 */
	#resolve(schedule: Schedule, firedAt: Date): Precheck | string {
		const { prechecks } = this.#options;
		if (schedule.precheck)
			return (
				prechecks?.get(schedule.precheck) ??
				"no precheck of that name is registered"
			);
		const script = schedule.precheckScript ?? "";
		const runner = prechecks?.scriptRunner?.();
		if (!runner)
			return "this host has no precheck script runner, so the script did not run";
		const tools = this.#tools(schedule, script, runner.toolName.bind(runner));
		if (typeof tools === "string") return tools;
		const zone = timeZone();
		return {
			name: SCRIPT_PRECHECK,
			description: "the schedule's own precheck script",
			...(runner.timeoutMs === undefined
				? {}
				: { timeoutMs: runner.timeoutMs }),
			run: (context) =>
				runner.run(script, {
					...context,
					timeZone: zone,
					today: zonedStamp(firedAt).slice(0, 10),
					tools: tools.map(({ server, tool }) => ({ server, tool })),
				}),
		};
	}

	/**
	 * The tools a script may call: those approved when it was saved, or, for a script saved before
	 * they were recorded, those it calls when none of them is held. Otherwise why it cannot run.
	 */
	#tools(
		schedule: Schedule,
		script: string,
		toolName: (server: string, tool: string) => string,
	): PrecheckTool[] | string {
		if (schedule.precheckTools) return schedule.precheckTools;
		const save =
			"save it again with schedule_update, so the owner can approve the tools it calls";
		const holds = this.#options.holds?.();
		if (!holds)
			return `this script was saved before its tools were recorded, and this host cannot check them; ${save}`;
		let tools: PrecheckTool[];
		try {
			tools = precheckScriptTools(script, { toolName, holds });
		} catch (error) {
			return `this script was saved before its tools were recorded and cannot be checked now (${error instanceof Error ? error.message : String(error)}); fix it and ${save}`;
		}
		const held = tools.flatMap((t) =>
			t.held ? [`${t.server}/${t.tool}`] : [],
		);
		if (held.length > 0)
			return `this script was saved before its tools were recorded and calls tools that need the owner's approval (${held.join(", ")}), so it did not run; ${save}`;
		return tools;
	}
}
