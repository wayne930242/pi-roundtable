import { PluginError } from "../../errors.ts";
import type { Schedule } from "./schedule-store.ts";

/** How long a precheck may run before it counts as failed, unless it sets its own `timeoutMs`. */
export const PRECHECK_TIMEOUT_MS = 60_000;

/** A precheck name: lower-case letters, digits, `.`, `_`, and `-`, starting with a letter or digit. */
const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** What a precheck decides about a due schedule. */
export type PrecheckResult =
	| {
			/** Skip the turn. A note is posted in the schedule's channel as the bot's own small message, which starts no turn. */
			wake: false;
			note?: string;
	  }
	| {
			/** Start the scheduled turn; its text carries `context` under a "Precheck found" heading. */
			wake: true;
			context: string;
	  };

/** What a precheck is given when its schedule falls due. */
export interface PrecheckContext {
	/** The due schedule, already moved to its next run (or deleted, when it runs once). */
	schedule: Schedule;
	firedAt: Date;
	/** Aborted when the precheck runs out of time; its answer is then ignored. */
	signal: AbortSignal;
}

/**
 * A cheap check the host runs before a schedule's turn, so the agent is woken only when there is
 * something to do. Host code registers it by name; the model can only attach a registered name to
 * a schedule, never supply code or a command.
 */
export interface Precheck {
	/** Unique on the host, such as `"health.recovery"`: lower-case letters, digits, `.`, `_`, `-`. */
	name: string;
	/** What it checks and when it wakes the agent, shown to the model by schedule_list. */
	description: string;
	/** How long it may run; default 60 seconds. A timeout counts as a throw. */
	timeoutMs?: number;
	/** Decides whether the turn runs. A throw starts the turn with the error, so the agent can look into it. */
	run(context: PrecheckContext): PrecheckResult | Promise<PrecheckResult>;
}

/** The host's prechecks, by name. Provided as `PRECHECKS` by the `prechecks` plugin. */
export interface PrecheckRegistry {
	/** Adds a precheck; throws PluginError for a bad or repeated name, an empty description, or a bad timeout. */
	register(precheck: Precheck): void;
	get(name: string): Precheck | undefined;
	/** Every registered precheck, by name. */
	list(): readonly Precheck[];
}

/** What came of a precheck that let the turn run, carried into the turn's text. */
export type PrecheckFinding =
	| { precheck: string; context: string }
	| { precheck: string; error: string };

/** The decision of one precheck run, with a throw, a timeout, or a bad answer as `failed`. */
export type PrecheckOutcome =
	| { kind: "skip"; note?: string }
	| { kind: "wake"; context: string }
	| { kind: "failed"; error: string };

/**
 * Prechecks kept in memory, as the host registers them while its plugins set up. Its methods
 * close over the map instead of private fields, so a test may hand it over through a proxy.
 */
export function memoryPrecheckRegistry(): PrecheckRegistry {
	const prechecks = new Map<string, Precheck>();
	return {
		register(precheck) {
			const { name, description, timeoutMs, run } = precheck ?? {};
			if (typeof name !== "string" || !NAME.test(name))
				throw new PluginError(
					`a precheck needs a name of lower-case letters, digits, ".", "_", and "-", such as "health.recovery"; got ${JSON.stringify(name)}.`,
				);
			if (prechecks.has(name))
				throw new PluginError(
					`precheck ${name} is already registered; give each precheck its own name.`,
				);
			if (typeof description !== "string" || !description.trim())
				throw new PluginError(
					`precheck ${name} needs a description: what it checks and when it wakes the agent.`,
				);
			if (
				timeoutMs !== undefined &&
				!(Number.isInteger(timeoutMs) && timeoutMs > 0)
			)
				throw new PluginError(
					`precheck ${name}: timeoutMs must be a positive whole number of milliseconds; got ${String(timeoutMs)}.`,
				);
			if (typeof run !== "function")
				throw new PluginError(`precheck ${name} needs a run function.`);
			prechecks.set(name, Object.freeze({ ...precheck }));
		},
		get: (name) => prechecks.get(name),
		list: () =>
			[...prechecks.values()].sort((a, b) => a.name.localeCompare(b.name)),
	};
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message || error.name : String(error);
}

/** Checks a precheck's answer, so a wrong shape fails like a throw instead of waking silently. */
function decided(result: unknown): PrecheckOutcome {
	if (result && typeof result === "object" && "wake" in result) {
		const answer = result as Record<string, unknown>;
		if (answer.wake === false) {
			const note = typeof answer.note === "string" ? answer.note.trim() : "";
			return note ? { kind: "skip", note } : { kind: "skip" };
		}
		if (answer.wake === true && typeof answer.context === "string")
			return { kind: "wake", context: answer.context };
	}
	return {
		kind: "failed",
		error: `it answered ${JSON.stringify(result)}, not { wake: false, note? } or { wake: true, context }`,
	};
}

/** Runs one precheck within its timeout; never rejects. */
export async function runPrecheck(
	precheck: Precheck,
	context: Omit<PrecheckContext, "signal">,
): Promise<PrecheckOutcome> {
	const timeoutMs = precheck.timeoutMs ?? PRECHECK_TIMEOUT_MS;
	const abort = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<PrecheckOutcome>((resolve) => {
		timer = setTimeout(() => {
			abort.abort();
			resolve({
				kind: "failed",
				error: `it did not answer within ${timeoutMs / 1000} seconds`,
			});
		}, timeoutMs);
	});
	const answer = (async (): Promise<PrecheckOutcome> => {
		try {
			return decided(await precheck.run({ ...context, signal: abort.signal }));
		} catch (error) {
			return { kind: "failed", error: `it threw: ${errorText(error)}` };
		}
	})();
	try {
		return await Promise.race([answer, timeout]);
	} finally {
		clearTimeout(timer);
	}
}
