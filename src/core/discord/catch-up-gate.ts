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
	 * since a process that begins to shut down releases what it recorded. Default 2000; 0 = never.
	 */
	retryMs?: number;
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
 * Once the host drains, an addressed message is not recorded, or its record is released, and it
 * does not run: the next process answers it, and its channel is told so once. Any other message
 * routing refuses then tells its channel once to send it again. Each notice is recorded, so
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
}: GateOptions): JournalGate {
	const told = { later: new Set<string>(), resend: new Set<string>() };
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
	const leave = async (message: InboundMessage, botId: string) => {
		logger.info(
			{ channelId: channelOf(message), messageId: message.messageId },
			"shutting down; the next process answers this message",
		);
		await tell("later", message, botId);
	};
	const claim = (message: InboundMessage, botId: string) =>
		journal.claim({
			botId,
			messageId: message.messageId,
			channelId: channelOf(message),
			direct: message.isDirect,
		});
	const pass = async (message: InboundMessage, botId: string) => {
		if (!addressed(message)) return true;
		if (draining()) {
			await leave(message, botId);
			return false;
		}
		const channelId = channelOf(message);
		const { messageId } = message;
		try {
			let first = await claim(message, botId);
			if (!first && retryMs > 0) {
				await Bun.sleep(retryMs);
				if (!draining()) first = await claim(message, botId);
			}
			if (!first) {
				logger.info(
					{ channelId, messageId },
					"message already taken in; not delivered again",
				);
				return false;
			}
			await wait?.(channelId);
			if (!draining()) return true;
			// The drain began while it was recorded: routing would refuse it, so the next process takes it.
			await journal.release(botId, messageId);
			await leave(message, botId);
			return false;
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
		if (!addressed(message)) {
			await tell("resend", message, botId);
			return true;
		}
		await journal.release(botId, message.messageId).catch((error: unknown) =>
			logger.warn(
				{
					channelId: channelOf(message),
					messageId: message.messageId,
					err: error,
				},
				"could not release a refused message; the next process does not answer it",
			),
		);
		await leave(message, botId);
		return true;
	};
	return Object.assign(pass, { refused });
}
