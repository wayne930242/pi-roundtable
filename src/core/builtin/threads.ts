import { join } from "node:path";
import type { RoundtablePlugin } from "../plugin.ts";
import { THREADS } from "../services.ts";
import { DispatchThreads } from "../threads/dispatch-threads.ts";

export interface ThreadsOptions {
	/** Where the ledger of the threads still open is kept, as `dispatch-threads.json`. */
	dataDir: string;
}

/**
 * The dispatch threads of every surface that hosts them. The plugin provides one instance, over
 * the host's surfaces; the Discord plugin hands the same one out as `DISCORD.threads`. After a
 * restart it closes the threads the last run left open, once every service has started, so each
 * surface is up to close its own.
 */
export function threadsPlugin(options: ThreadsOptions): RoundtablePlugin {
	return {
		name: "threads",
		provides: [THREADS],
		setup: ({ conversations, services, surfaces, logger }) => {
			const threads = new DispatchThreads({
				surfaces,
				ledgerPath: join(options.dataDir, "dispatch-threads.json"),
				// A channel whose claim keeps reports in place, such as an open channel, opens no thread.
				excluded: (channel) => conversations.postsInPlace(channel),
				logger,
			});
			services.provide(THREADS, threads);
			return {
				services: [
					{ name: "threads", startInBackground: () => threads.sweep() },
				],
			};
		},
	};
}
