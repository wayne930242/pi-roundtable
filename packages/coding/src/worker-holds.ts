import type { HoldCheck } from "pi-roundtable";

/**
 * The worker's host hold check: the plugin's extra rules, else the linked host rules, with the
 * classes of every check that holds a call so yolo mode can judge it; a check that holds a call
 * without telling its classes leaves the call unclassed.
 */
export function workerHolds(
	extra: HoldCheck | undefined,
	linked: () => HoldCheck,
): HoldCheck {
	const check: HoldCheck = (tool, input, scope) =>
		extra?.(tool, input, scope) ?? linked()(tool, input, scope);
	check.classesOf = (tool, input, scope) => {
		const found: string[] = [];
		for (const holds of extra ? [extra, linked()] : [linked()]) {
			if (holds(tool, input, scope) === undefined) continue;
			const classes = holds.classesOf?.(tool, input, scope);
			if (!classes?.length) return undefined;
			found.push(...classes);
		}
		return found.length ? [...new Set(found)] : undefined;
	};
	return check;
}
