/**
 * The HTTP client the push posts go through, set per options object by tests only: it is kept out
 * of the public options so a deployment cannot send pushes anywhere but through `fetch`.
 */
const fetches = new WeakMap<object, typeof fetch>();

/** Makes the options post through `fetch`; returns the same object. */
export function withPushFetch<T extends object>(
	options: T,
	client: typeof fetch,
): T {
	fetches.set(options, client);
	return options;
}

export const pushFetchOf = (options: object): typeof fetch | undefined =>
	fetches.get(options);
