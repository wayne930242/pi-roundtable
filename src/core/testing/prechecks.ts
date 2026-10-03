import {
	memoryPrecheckRegistry,
	type Precheck,
	type PrecheckContext,
	type PrecheckRegistry,
	type PrecheckResult,
	type PrecheckScope,
	type PrecheckScriptContext,
	type PrecheckScriptRunner,
} from "../modules/schedules/prechecks.ts";

/** What a fake precheck answers: a result, an Error it throws, or a function of its context. */
export type FakePrecheckAnswer =
	| PrecheckResult
	| Error
	| ((context: PrecheckContext) => PrecheckResult | Promise<PrecheckResult>);

/** A precheck for tests, which records every context it ran with. */
export interface FakePrecheck extends Precheck {
	readonly calls: PrecheckContext[];
}

/**
 * A precheck that answers as the test says, for registering where host code would:
 * `services.get(PRECHECKS).register(fakePrecheck("health.recovery", { wake: false }))`, or into
 * `fakePrechecks(...)`. An Error answer is thrown, as a failing check would.
 */
export function fakePrecheck(
	name: string,
	answer: FakePrecheckAnswer,
	options: { description?: string; timeoutMs?: number } = {},
): FakePrecheck {
	const calls: PrecheckContext[] = [];
	return {
		name,
		description: options.description ?? `A test precheck, ${name}.`,
		...(options.timeoutMs === undefined
			? {}
			: { timeoutMs: options.timeoutMs }),
		calls,
		run: async (context) => {
			calls.push(context);
			if (answer instanceof Error) throw answer;
			return typeof answer === "function" ? answer(context) : answer;
		},
	};
}

/** What a fake script runner answers: a result, an Error it throws, or a function of the script and its context. */
export type FakeScriptAnswer =
	| PrecheckResult
	| Error
	| ((
			script: string,
			context: PrecheckScriptContext,
	  ) => PrecheckResult | Promise<PrecheckResult>);

/** A precheck script runner for tests, which records every script it was asked to run. */
export interface FakeScriptRunner extends PrecheckScriptRunner {
	readonly calls: { script: string; context: PrecheckScriptContext }[];
}

/**
 * A script runner that runs nothing: it answers as the test says, for
 * `registry.useScriptRunner(fakeScriptRunner({ wake: false }))`. `describe` defaults to a line
 * naming it a test runner.
 */
export function fakeScriptRunner(
	answer: FakeScriptAnswer,
	options: {
		describe?: (scope: PrecheckScope) => string;
		timeoutMs?: number;
	} = {},
): FakeScriptRunner {
	const calls: FakeScriptRunner["calls"] = [];
	return {
		calls,
		...(options.timeoutMs === undefined
			? {}
			: { timeoutMs: options.timeoutMs }),
		describe: options.describe ?? (() => "A test script runner."),
		run: async (script, context) => {
			calls.push({ script, context });
			if (answer instanceof Error) throw answer;
			return typeof answer === "function" ? answer(script, context) : answer;
		},
	};
}

/**
 * A real in-memory precheck registry with the given prechecks registered, for a test that builds
 * a scheduler or schedule tools itself. It refuses what the host's refuses.
 */
export function fakePrechecks(
	...prechecks: readonly Precheck[]
): PrecheckRegistry {
	const registry = memoryPrecheckRegistry();
	for (const precheck of prechecks) registry.register(precheck);
	return registry;
}
