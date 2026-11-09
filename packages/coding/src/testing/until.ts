/**
 * Polls `check` until it returns something other than `undefined`, `null` or `false`,
 * and returns that value. A fixed `Bun.sleep` guesses how long a step takes; this waits
 * for the step itself and fails with `what` when it never happens within `ms`.
 */
export async function until<T>(
	check: () => T | Promise<T>,
	what: string,
	ms = 10_000,
): Promise<Exclude<T, undefined | null | false>> {
	const deadline = Date.now() + ms;
	for (;;) {
		const found = await check();
		if (found !== undefined && found !== null && found !== false)
			return found as Exclude<T, undefined | null | false>;
		if (Date.now() > deadline) throw new Error(`never happened: ${what}`);
		await Bun.sleep(10);
	}
}
