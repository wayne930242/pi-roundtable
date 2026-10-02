import { useEffect, useState } from "react";
import { messageOf } from "./api.ts";
import { useLive } from "./live.ts";

interface Fetched<T> {
	data: T | undefined;
	error: string | undefined;
}

/**
 * What `load` returns, fetched again whenever the server reports a change and on every tick.
 * `subject` names what is being loaded: when it changes, the previous subject's data and error
 * are dropped at once, and an answer that arrives for an earlier subject or an earlier fetch is
 * ignored, so a slow response never overwrites a newer one.
 */
export function useFetched<T>(
	load: () => Promise<T>,
	subject: string,
): Fetched<T> {
	const { version } = useLive();
	const [state, setState] = useState<Fetched<T> & { subject: string }>({
		data: undefined,
		error: undefined,
		subject,
	});
	// biome-ignore lint/correctness/useExhaustiveDependencies: `load` is rebuilt on every render; the subject and the version say when to fetch
	useEffect(() => {
		let current = true;
		load().then(
			(data) => {
				if (current) setState({ data, error: undefined, subject });
			},
			(failure) => {
				if (current)
					setState((previous) => ({
						data: previous.subject === subject ? previous.data : undefined,
						error: messageOf(failure),
						subject,
					}));
			},
		);
		return () => {
			current = false;
		};
	}, [subject, version]);
	return state.subject === subject
		? { data: state.data, error: state.error }
		: { data: undefined, error: undefined };
}
