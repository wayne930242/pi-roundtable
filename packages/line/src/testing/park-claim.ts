import type { SQL } from "bun";

/** The query a claim runs to pick the oldest due event of each chat; the claim looks at the inbox here. */
const HEADS = "DISTINCT ON (i.source_key)";

type Call = (...args: unknown[]) => unknown;

/** How long a test waits for a claim to reach the query before it is told the query is gone. */
const WAIT_MS = 5_000;

export interface ClaimParker {
	/** `sql` as the inbox worker should be given it. */
	sql: SQL;
	/**
	 * Holds the next claim of the inbox just before it looks at the inbox, and resolves once it is
	 * held, with the function that lets it go on. What the test stores or detaches meanwhile is
	 * what the claim finds; its clock reading was taken before, so it is the claim of a moment ago.
	 */
	park(): Promise<() => void>;
}

/**
 * Lets a test hold the inbox worker's claim between its start and its look at the inbox. A claim
 * is the one window in which the subscriber can be detached after the worker has found one, and
 * only holding it there makes that window the test's to open instead of the machine's to choose.
 */
export function claimParker(sql: SQL): ClaimParker {
	let armed: { reached: () => void; go: Promise<void> } | undefined;
	const gated = (tx: SQL): SQL =>
		new Proxy(tx, {
			apply(target, self, args: unknown[]) {
				// SAFETY: a transaction handle is the tagged-template function itself; the interface only hides its call signature.
				const run = target as unknown as Call;
				const parts = args[0];
				const held = armed;
				if (held && Array.isArray(parts) && parts.join("").includes(HEADS)) {
					armed = undefined;
					held.reached();
					return held.go.then(() => run.apply(self, args));
				}
				return run.apply(self, args);
			},
		});
	const proxy = new Proxy(sql, {
		get(target, key) {
			if (key === "begin")
				return (...args: unknown[]) => {
					const run = args.pop() as (tx: SQL) => unknown;
					const begin = target.begin as (...a: unknown[]) => unknown;
					return begin.call(target, ...args, (tx: SQL) => run(gated(tx)));
				};
			const value: unknown = Reflect.get(target, key, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	return {
		sql: proxy,
		park: () =>
			new Promise<() => void>((resolve, reject) => {
				let release: () => void = () => undefined;
				const go = new Promise<void>((letGo) => {
					release = letGo;
				});
				const timer = setTimeout(() => {
					armed = undefined;
					reject(
						new Error("no claim reached the inbox query: has it changed?"),
					);
				}, WAIT_MS);
				armed = {
					go,
					reached: () => {
						clearTimeout(timer);
						resolve(release);
					},
				};
			}),
	};
}
