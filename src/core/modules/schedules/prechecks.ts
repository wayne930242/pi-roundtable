import { parse } from "@babel/parser";
import type { ChannelKey } from "../../domain/conversation.ts";
import { ScheduleError } from "../../domain/errors.ts";
import { PluginError } from "../../errors.ts";
import type { Tier } from "../../speakers.ts";
import type { Schedule } from "./schedule-store.ts";

/** How long a precheck may run before it counts as failed, unless it sets its own `timeoutMs`. */
export const PRECHECK_TIMEOUT_MS = 60_000;

/** The longest precheck script a schedule may carry, in characters. */
export const PRECHECK_SCRIPT_CHARS = 8_000;

/** What a finding names a schedule's own script by, in its heading and status. */
export const SCRIPT_PRECHECK = "script";

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
	/** Aborted when the precheck runs out of time or the host stops; its answer is then ignored. */
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

/** Whose schedule a script is for: the runner decides what such a script may reach from it. */
export interface PrecheckScope {
	channel: ChannelKey;
	/** The schedule's background target, such as the owner's. */
	target: string;
	/**
	 * The tier of whoever set the script: its creator's when it runs, the asker's when schedule_list
	 * describes it; absent when the asker's is unknown. A runner may grant lower tiers less.
	 */
	tier?: Tier;
}

/** What a schedule's precheck script runs with when its schedule falls due. */
export interface PrecheckScriptContext extends PrecheckContext {
	/** The host's IANA time zone, such as `Asia/Taipei`. */
	timeZone: string;
	/** The date in that zone when it fired, `YYYY-MM-DD`, so a script never reads a UTC date by mistake. */
	today: string;
}

/**
 * Runs the precheck scripts agents write for their schedules, isolated from the host: the core
 * stores, checks, and schedules them but never runs one itself. Provided by a sandbox, such as
 * pi-roundtable-sandbox's `precheckScriptRunner`, through `PRECHECKS.useScriptRunner`.
 */
export interface PrecheckScriptRunner {
	/** Runs one script; its answer is checked like a host precheck's, and a throw wakes the turn with the error. */
	run(
		script: string,
		context: PrecheckScriptContext,
	): PrecheckResult | Promise<PrecheckResult>;
	/** How long a script may run; default 60 seconds. A timeout counts as a throw. */
	timeoutMs?: number;
	/**
	 * How to write a script for a schedule in this scope, and what it may call there, shown to the
	 * model by schedule_list.
	 */
	describe(scope: PrecheckScope): string | Promise<string>;
}

/** The host's prechecks, by name, and the runner of agents' precheck scripts. Provided as `PRECHECKS` by the `prechecks` plugin. */
export interface PrecheckRegistry {
	/** Adds a precheck; throws PluginError for a bad or repeated name, an empty description, or a bad timeout. */
	register(precheck: Precheck): void;
	get(name: string): Precheck | undefined;
	/** Every registered precheck, by name. */
	list(): readonly Precheck[];
	/** Lets agents attach scripts of their own, run by this runner; throws PluginError when one is set already. */
	useScriptRunner(runner: PrecheckScriptRunner): void;
	/** The runner of precheck scripts; undefined when no sandbox provides one, and then no script is accepted. */
	scriptRunner(): PrecheckScriptRunner | undefined;
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
	let runner: PrecheckScriptRunner | undefined;
	return {
		useScriptRunner(given) {
			if (runner)
				throw new PluginError(
					"a precheck script runner is set already; register one sandbox to run scripts.",
				);
			if (
				typeof given?.run !== "function" ||
				typeof given.describe !== "function"
			)
				throw new PluginError(
					"a precheck script runner needs run and describe functions.",
				);
			if (
				given.timeoutMs !== undefined &&
				!(Number.isInteger(given.timeoutMs) && given.timeoutMs > 0)
			)
				throw new PluginError(
					`a precheck script runner's timeoutMs must be a positive whole number of milliseconds; got ${String(given.timeoutMs)}.`,
				);
			runner = given;
		},
		scriptRunner: () => runner,
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

/**
 * Checks a precheck script without running it: a JavaScript module within the size limit whose
 * default export is what the runner calls. Throws ScheduleError with what to fix.
 */
export function checkPrecheckScript(script: unknown): string {
	if (typeof script !== "string" || !script.trim())
		throw new ScheduleError(
			"precheck_script must be a JavaScript module with a default export",
		);
	if (script.length > PRECHECK_SCRIPT_CHARS)
		throw new ScheduleError(
			`precheck_script is ${script.length} characters; keep it within ${PRECHECK_SCRIPT_CHARS}`,
		);
	let program: ReturnType<typeof parse>["program"];
	try {
		program = parse(script, {
			sourceType: "module",
			errorRecovery: false,
		}).program;
	} catch (error) {
		throw new ScheduleError(
			`precheck_script does not parse as a JavaScript module: ${errorText(error)}`,
		);
	}
	const exportsDefault = program.body.some(
		(node) =>
			node.type === "ExportDefaultDeclaration" ||
			(node.type === "ExportNamedDeclaration" &&
				node.specifiers.some((specifier) =>
					specifier.exported.type === "Identifier"
						? specifier.exported.name === "default"
						: specifier.exported.value === "default",
				)),
	);
	if (!exportsDefault)
		throw new ScheduleError(
			"precheck_script needs a default export: export default async (context) => ({ wake: false, note }) or ({ wake: true, context })",
		);
	return script;
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
	options: {
		/** Aborts the run early, such as when the host stops; it then fails with `stopped`. */
		signal?: AbortSignal;
		/** Receives the run itself, which may outlast the answer after a timeout, so a caller can await its cleanup. */
		settled?: (run: Promise<unknown>) => void;
	} = {},
): Promise<PrecheckOutcome> {
	const timeoutMs = precheck.timeoutMs ?? PRECHECK_TIMEOUT_MS;
	const abort = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let stop: (() => void) | undefined;
	const timeout = new Promise<PrecheckOutcome>((resolve) => {
		timer = setTimeout(() => {
			abort.abort();
			resolve({
				kind: "failed",
				error: `it did not answer within ${timeoutMs / 1000} seconds`,
			});
		}, timeoutMs);
		stop = () => {
			abort.abort();
			resolve({ kind: "failed", error: "stopped: the host is shutting down" });
		};
		if (options.signal?.aborted) stop();
		else options.signal?.addEventListener("abort", stop, { once: true });
	});
	const answer = (async (): Promise<PrecheckOutcome> => {
		try {
			return decided(await precheck.run({ ...context, signal: abort.signal }));
		} catch (error) {
			return { kind: "failed", error: `it threw: ${errorText(error)}` };
		}
	})();
	options.settled?.(answer);
	try {
		return await Promise.race([answer, timeout]);
	} finally {
		clearTimeout(timer);
		if (stop) options.signal?.removeEventListener("abort", stop);
	}
}
