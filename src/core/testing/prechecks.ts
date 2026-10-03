import {
	memoryPrecheckRegistry,
	type Precheck,
	type PrecheckContext,
	type PrecheckRegistry,
	type PrecheckResult,
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
