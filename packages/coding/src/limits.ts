import { AgentError } from "pi-roundtable/kit";

const MAX_TIMER_MS = 2_147_483_647;
/** The most coding workers a host may run at once. */
export const MAX_WORKERS_LIMIT = 64;

export function checkLimit(name: string, value: number | undefined): void {
	if (
		value !== undefined &&
		value !== Number.POSITIVE_INFINITY &&
		(!Number.isSafeInteger(value) || value < 1)
	)
		throw new Error(
			`${name} must be a whole number of at least 1, or Infinity; got ${value}.`,
		);
}
export function checkTime(name: string, value: number): void {
	if (!Number.isFinite(value) || value <= 0 || value > MAX_TIMER_MS)
		throw new AgentError(
			`${name} must be positive, finite and at most ${MAX_TIMER_MS}.`,
		);
}
export function checkCount(
	name: string,
	value: number,
	least: number,
	most = Number.MAX_SAFE_INTEGER,
): void {
	if (!Number.isSafeInteger(value) || value < least || value > most)
		throw new AgentError(
			most === Number.MAX_SAFE_INTEGER
				? `${name} must be a whole number of at least ${least}; got ${value}.`
				: `${name} must be a whole number from ${least} to ${most}; got ${value}.`,
		);
}
/** Throws unless `value` is a worker limit: a whole number from 1 to 64. */
export function checkMaxWorkers(value: number): void {
	checkCount("maxWorkers", value, 1, MAX_WORKERS_LIMIT);
}
