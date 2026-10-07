/**
 * How one check ended: passed, passed with a warning and what to do about it, failed with what to
 * do, or not run because it needs something an earlier check reports. A warning fails nothing.
 */
export type Result =
	| { status: "ok"; detail?: string }
	| { status: "warn"; problem: string; fix: string }
	| { status: "fail"; problem: string; fix: string }
	| { status: "skipped"; reason: string };

/** One thing `doctor` looks at. `offline` checks need no network, so `start` runs them too. */
export interface Check {
	name: string;
	offline: boolean;
	run(): Promise<Result>;
}

export interface Outcome {
	name: string;
	result: Result;
}

export const ok = (detail?: string): Result =>
	detail === undefined ? { status: "ok" } : { status: "ok", detail };
export const fail = (problem: string, fix: string): Result => ({
	status: "fail",
	problem,
	fix,
});
export const warn = (problem: string, fix: string): Result => ({
	status: "warn",
	problem,
	fix,
});
export const skipped = (reason: string): Result => ({
	status: "skipped",
	reason,
});

const errorText = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

/** Runs the checks in order. A check that throws fails with its message, so a bug in one never hides the rest. */
export async function runChecks(checks: readonly Check[]): Promise<Outcome[]> {
	const outcomes: Outcome[] = [];
	for (const check of checks) {
		try {
			outcomes.push({ name: check.name, result: await check.run() });
		} catch (error) {
			outcomes.push({
				name: check.name,
				result: fail(
					`the check itself failed: ${errorText(error)}`,
					"Report this as a bug in roundtable doctor.",
				),
			});
		}
	}
	return outcomes;
}

export const failed = (outcomes: readonly Outcome[]): Outcome[] =>
	outcomes.filter(({ result }) => result.status === "fail");

/** One line per check, and for a warning or a failure its problem and fix underneath. */
export function formatOutcomes(outcomes: readonly Outcome[]): string[] {
	return outcomes.flatMap(({ name, result }) => {
		if (result.status === "ok")
			return [`✓ ${name}${result.detail ? `: ${result.detail}` : ""}`];
		if (result.status === "skipped")
			return [`- ${name}: skipped, ${result.reason}`];
		return [
			`${result.status === "warn" ? "!" : "✗"} ${name}: ${result.problem}`,
			...result.fix.split("\n").map((line) => `    ${line}`),
		];
	});
}
