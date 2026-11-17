import type { Client } from "discord.js";
import type { InboundMessage } from "../contract/channels.ts";
import { messages } from "../i18n/index.ts";
import type { Logger } from "../kernel/log.ts";
import type { Service } from "../plugin-api/plugin.ts";
import {
	type CatchUpSettings,
	catchUp,
	DAY_MS,
	JOURNAL_DAYS,
	journalGate,
} from "./catch-up.ts";
import type { InboundJournal } from "./catch-up-journal.ts";
import { clientCatchUpReader, postNotice } from "./catch-up-reader.ts";

/** How often the journal forgets what is older than it keeps, while the host runs. */
const PRUNE_EVERY_MS = DAY_MS / 4;

export interface CatchUpWiringOptions {
	journal: InboundJournal;
	settings: CatchUpSettings;
	logger: Logger;
	/** The surface's client, once it is connected. */
	client: () => Client;
	/** Hands a caught-up message to routing. */
	deliver: (message: InboundMessage) => void;
	/** The interval timer, replaceable in a test. */
	every?: (run: () => void, ms: number) => { stop(): void };
}

const interval = (run: () => void, ms: number) => {
	const timer = setInterval(run, ms);
	timer.unref?.();
	return { stop: () => clearInterval(timer) };
};

/**
 * The live gateway's journal gate and the catch-up service, sharing whether the host drains and
 * which messages the gateway delivered without a record. The service prunes the journal now and
 * then while it runs, so a host that is never restarted keeps only `JOURNAL_DAYS` of records.
 */
export function catchUpWiring(options: CatchUpWiringOptions): {
	gate: ReturnType<typeof journalGate>;
	service: Service;
} {
	const { journal, logger } = options;
	let draining = false;
	// Only catch-up reads it, and it runs once: after it, nothing more is kept.
	const unrecorded = new Set<string>();
	let caughtUp = false;
	let pruning: { stop(): void } | undefined;
	// A live message waits until catch-up knows which channels it reads, and in one of those, until it is done.
	let plan!: (ids: Set<string>) => void;
	const planned = new Promise<Set<string>>((resolve) => {
		plan = resolve;
	});
	let finish!: () => void;
	const finished = new Promise<void>((resolve) => {
		finish = resolve;
	});
	const release = () => {
		plan(new Set());
		finish();
		caughtUp = true;
		unrecorded.clear();
	};
	const wait = async (channelId: string) => {
		if ((await planned).has(channelId)) await finished;
	};
	const prune = () =>
		void journal
			.prune(new Date(Date.now() - JOURNAL_DAYS * DAY_MS))
			.catch((error: unknown) =>
				logger.warn({ err: error }, "could not prune the inbound journal"),
			);
	return {
		gate: journalGate({
			journal,
			logger,
			draining: () => draining,
			notify: (channelId) =>
				postNotice(
					options.client(),
					channelId,
					messages().restartingAnswerLater,
				),
			wait,
			unrecorded: {
				add: (id) => (caughtUp ? unrecorded : unrecorded.add(id)),
			},
		}),
		service: {
			name: "discord-catch-up",
			start: () => {
				pruning = (options.every ?? interval)(prune, PRUNE_EVERY_MS);
			},
			// After every service is up, so the missed messages reach claims that are ready.
			startInBackground: async () => {
				try {
					await catchUp({
						reader: clientCatchUpReader(options.client()),
						journal,
						deliver: options.deliver,
						settings: options.settings,
						logger,
						stopping: () => draining,
						planned: (ids) => plan(new Set(ids)),
						passedLive: (id) => unrecorded.has(id),
					});
				} finally {
					release();
				}
			},
			beginDrain: () => {
				draining = true;
				release();
			},
			stop: () => {
				pruning?.stop();
			},
		},
	};
}
