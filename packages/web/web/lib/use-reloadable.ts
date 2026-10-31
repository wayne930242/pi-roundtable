import { useCallback, useEffect, useState } from "react";
import { messageOf } from "./api.ts";
import { useLive } from "./live.ts";

/**
 * What `load` returns, fetched on mount, whenever the server reports a change, and on `reload()`.
 * Unlike `useFetched`, the shown data stays while a newer answer is on its way, so a list does not
 * blink after each change made from it.
 */
export function useReloadable<T>(load: () => Promise<T>): {
	data: T | undefined;
	error: string | undefined;
	reload(): void;
} {
	const { version } = useLive();
	const [tick, setTick] = useState(0);
	const [data, setData] = useState<T>();
	const [error, setError] = useState<string>();
	// biome-ignore lint/correctness/useExhaustiveDependencies: `load` is rebuilt on every render; the tick and the version say when to fetch
	useEffect(() => {
		let current = true;
		load().then(
			(next) => {
				if (!current) return;
				setData(next);
				setError(undefined);
			},
			(failure) => {
				if (current) setError(messageOf(failure));
			},
		);
		return () => {
			current = false;
		};
	}, [tick, version]);
	const reload = useCallback(() => setTick((n) => n + 1), []);
	return { data, error, reload };
}
