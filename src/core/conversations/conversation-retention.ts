import type { ConversationPort } from "../contract/channels.ts";
import type { Logger } from "../log.ts";
import type { Service } from "../plugin.ts";
import type { ConversationRegistry } from "./conversation-registry.ts";

const DAY_MS = 24 * 60 * 60_000;

/** What the sweep needs: the records, the way to delete a conversation, the clock. */
export interface ConversationRetentionOptions {
	registry: ConversationRegistry;
	/** Deletes a conversation as its claim does; `busy` while a turn runs or waits in it. */
	conversations: Pick<ConversationPort, "deleteConversation">;
	/** Days to keep each kind after its last activity; a kind not listed is kept. */
	keepDays: Readonly<Record<string, number>>;
	now: () => Date;
	logger: Logger;
}

/** How one sweep ended, in conversations. */
export interface ConversationSweep {
	deleted: number;
	/** A turn was running or waiting: tried again at the next sweep. */
	busy: number;
	/** Its claim could not delete it: logged, and tried again at the next sweep. */
	failed: number;
}

/**
 * Deletes the recorded conversations whose kind has a `keepDays` and that were last active longer
 * ago, then forgets their records. One that is busy is skipped for this sweep; one whose deletion
 * throws is logged and skipped, and neither stops the others.
 */
export async function sweepConversations(
	options: ConversationRetentionOptions,
): Promise<ConversationSweep> {
	const { registry, conversations, keepDays, now, logger } = options;
	const result: ConversationSweep = { deleted: 0, busy: 0, failed: 0 };
	const at = now().getTime();
	for (const record of await registry.list()) {
		const days = keepDays[record.kind];
		if (
			days === undefined ||
			at - record.lastActiveAt.getTime() < days * DAY_MS
		)
			continue;
		try {
			const outcome = await conversations.deleteConversation(record.key);
			if (outcome === "busy") {
				result.busy += 1;
				continue;
			}
			await registry.remove?.(record.key);
			result.deleted += 1;
		} catch (error) {
			result.failed += 1;
			logger.warn(
				{ channel: record.key, kind: record.kind, err: error },
				"conversation past its keepDays not deleted",
			);
		}
	}
	return result;
}

/** The wait between two sweeps. */
export const SWEEP_EVERY_MS = DAY_MS;

/**
 * The service that deletes idle conversations: one sweep when the host starts, then one a day,
 * never two at once. A sweep that fails is logged and the next tries again.
 */
export function conversationRetentionService(
	options: ConversationRetentionOptions,
): Service {
	let timer: ReturnType<typeof setInterval> | undefined;
	let sweeping: Promise<void> | undefined;
	const sweep = async (): Promise<void> => {
		try {
			const result = await sweepConversations(options);
			if (result.deleted + result.busy + result.failed > 0)
				options.logger.info(result, "conversations past their keepDays swept");
		} catch (error) {
			options.logger.warn(
				{ err: error },
				"conversations past their keepDays not swept",
			);
		}
	};
	const once = (): Promise<void> => {
		sweeping ??= sweep().finally(() => {
			sweeping = undefined;
		});
		return sweeping;
	};
	return {
		name: "conversation-retention",
		start: async () => {
			await once();
			timer = setInterval(() => void once(), SWEEP_EVERY_MS);
		},
		stop: async () => {
			clearInterval(timer);
			timer = undefined;
			await sweeping;
		},
	};
}
