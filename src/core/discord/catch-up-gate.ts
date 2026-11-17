import type { InboundMessage } from "../contract/channels.ts";
import type { Logger } from "../kernel/log.ts";
import { addressed } from "./catch-up.ts";
import type { InboundJournal } from "./catch-up-journal.ts";

/** Which restart notice a channel is told: that its message is answered after the restart, or that it should be sent again. */
export type NoticeKind = "later" | "resend";

/** A notice posted in a channel. */
export interface PostedNotice {
	id: string;
	/** Deletes it again. */
	retract(): Promise<void>;
}

/** What the live gateway's journal gate works with. */
export interface GateOptions {
	journal: InboundJournal;
	logger: Logger;
	/** True once the host shuts down: from then on routing refuses what it hears. */
	draining?: () => boolean;
	/** Posts a restart notice in a channel. */
	notify?: (channelId: string, kind: NoticeKind) => Promise<PostedNotice>;
	/** Waits, once a message is recorded, until it may reach routing after the caught-up messages of its channel. */
	wait?: (channelId: string) => Promise<void>;
	/** The ids of messages delivered without a record, which catch-up in this process leaves alone. */
	unrecorded?: Pick<Set<string>, "add">;
	/**
	 * How long a message another process recorded first is given before it is claimed once more,
	 * since a process that begins to shut down leaves what it recorded. Default 2000; 0 = never.
	 */
	retryMs?: number;
	/** Hands a message the retry claimed to routing; without it there is no retry. */
	redeliver?: (message: InboundMessage) => void;
}

/** The gate: whether a live message reaches routing, and `refused`, for one routing refuses as the host stops. */
export type JournalGate = ((
	message: InboundMessage,
	botId: string,
) => Promise<boolean>) & {
	/** Takes care of a message routing refuses because the host stops; true when it did, so routing posts nothing. */
	refused(message: InboundMessage, botId: string): Promise<boolean>;
};

const DEFAULT_RETRY_MS = 2000;

/**
 * Records each addressed message the live gateway delivers before routing hears it, so catch-up
 * after a restart leaves it alone; false for one already recorded, which is not delivered again.
 * A message that cannot be recorded is still delivered, logged, and kept in `unrecorded`.
 * Once the host drains, an addressed message still reaches routing unrecorded, so only one routing
 * refuses as the host stops, one a claim would have answered, is recorded as left: the next process
 * answers it whatever its channel shows since, and its channel is told so once. One that cannot be
 * left gets no notice, as catch-up finds it unrecorded in its window. Any other message routing
 * refuses then tells its channel once to send it again. Each notice is recorded, so
 * catch-up does not take it for an answer, and deleted again when it cannot be.
 */
export function journalGate({
	journal,
	logger,
	draining = () => false,
	notify,
	wait,
	unrecorded,
	retryMs = DEFAULT_RETRY_MS,
	redeliver,
}: GateOptions): JournalGate {
	const told = { later: new Set<string>(), resend: new Set<string>() };
	// Addressed messages passed during the drain without a record: routing decides whether they are left.
	// An entry routing never refuses stays until the process exits; the drain bounds the set, and the process ends after it.
	const unclaimed = new Set<string>();
	const channelOf = (message: InboundMessage) =>
		message.channel.slice("discord:".length);
	const tell = async (
		kind: NoticeKind,
		message: InboundMessage,
		botId: string,
	) => {
		const channelId = channelOf(message);
		if (!notify || told[kind].has(channelId)) return;
		told[kind].add(channelId);
		let notice: PostedNotice;
		try {
			notice = await notify(channelId, kind);
		} catch (error) {
			logger.warn({ channelId, err: error }, "restart notice not posted");
			return;
		}
		try {
			await journal.claim({
				botId,
				messageId: notice.id,
				channelId,
				direct: message.isDirect,
			});
		} catch (error) {
			// Unrecorded, catch-up would take it for an answer.
			logger.warn(
				{ channelId, err: error },
				"restart notice not recorded; deleting it",
			);
			await notice
				.retract()
				.catch((retractError: unknown) =>
					logger.warn(
						{ channelId, err: retractError },
						"unrecorded restart notice not deleted",
					),
				);
		}
	};
	const entry = (message: InboundMessage, botId: string) => ({
		botId,
		messageId: message.messageId,
		channelId: channelOf(message),
		direct: message.isDirect,
	});
	// Left in the journal, the next process answers it whatever its channel shows. A recorded one that
	// cannot be left is told to be sent again; an unrecorded one is told nothing, as catch-up answers it.
	const leave = async (
		message: InboundMessage,
		botId: string,
		taken = true,
	) => {
		const where = {
			channelId: channelOf(message),
			messageId: message.messageId,
		};
		try {
			if (taken) await journal.leave(entry(message, botId));
			else if (!(await journal.leaveNew(entry(message, botId)))) {
				// Another process took it in, and answers it.
				logger.info(
					where,
					"shutting down; another process took this message in",
				);
				return;
			}
		} catch (error) {
			if (!taken) {
				logger.warn(
					{ ...where, err: error },
					"could not leave a message for the next process; unrecorded, catch-up answers it",
				);
				return;
			}
			logger.warn(
				{ ...where, err: error },
				"could not leave a message for the next process; its channel is told to send it again",
			);
			await tell("resend", message, botId);
			return;
		}
		logger.info(where, "shutting down; the next process answers this message");
		await tell("later", message, botId);
	};
	// Off the channel's chain: a process that begins to stop leaves what it recorded, and this one then takes it.
	const retry = (message: InboundMessage, botId: string) => {
		if (!redeliver || retryMs <= 0) return;
		const timer = setTimeout(async () => {
			if (draining()) return;
			let first = false;
			try {
				first = await journal.claim(entry(message, botId));
				if (!first) return;
				await wait?.(channelOf(message));
				// Late, and after newer messages of its channel.
				redeliver({ ...message, caughtUp: true });
			} catch (error) {
				logger.warn(
					{ messageId: message.messageId, err: error },
					"could not claim or deliver a message again",
				);
				// Taken but not delivered: left, a later process answers it.
				if (first)
					await journal.leave(entry(message, botId)).catch(() => undefined);
			}
		}, retryMs);
		timer.unref?.();
	};
	const pass = async (message: InboundMessage, botId: string) => {
		if (!addressed(message)) return true;
		if (draining()) {
			// Routing refuses it, through `refused`, only when a claim would have answered it.
			unclaimed.add(message.messageId);
			return true;
		}
		const channelId = channelOf(message);
		const { messageId } = message;
		try {
			if (!(await journal.claim(entry(message, botId)))) {
				logger.info(
					{ channelId, messageId },
					"message already taken in; not delivered again",
				);
				retry(message, botId);
				return false;
			}
			await wait?.(channelId);
			// Should the drain have begun meanwhile, routing refuses it, and `refused` leaves it.
			return true;
		} catch (error) {
			unrecorded?.add(messageId);
			logger.warn(
				{ channelId, messageId, err: error },
				"could not record an addressed message; delivered anyway",
			);
			return true;
		}
	};
	const refused = async (message: InboundMessage, botId: string) => {
		if (!notify || message.authorIsBot || message.integration) return false;
		if (addressed(message))
			await leave(message, botId, !unclaimed.delete(message.messageId));
		else await tell("resend", message, botId);
		return true;
	};
	return Object.assign(pass, { refused });
}
