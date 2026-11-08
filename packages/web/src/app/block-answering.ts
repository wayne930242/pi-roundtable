import {
	type Answer,
	type BlockSegment,
	encodeAnswer,
	parse,
	validateAnswer,
} from "pi-better-show";
import type { ChannelKey, Logger } from "pi-roundtable";
import {
	type BlockFields,
	type BlockRefusalCode,
	type ClientFrame,
	MAX_MESSAGE_CHARS,
	type RoomMessage,
} from "../api-types.ts";
import type { Answerer } from "./desk.ts";
import type { RoomLog } from "./room-log.ts";
import type { Rooms } from "./rooms.ts";
import type { AppSurface } from "./surface.ts";

export interface BlockAnsweringDeps {
	rooms: Pick<Rooms, "resolve">;
	log: Pick<RoomLog, "answerable" | "answers">;
	surface: Pick<AppSurface, "started" | "showChange">;
	logger: Pick<Logger, "warn">;
}

/** What an answer to a block came to: the owner's message that carries it, or why it was not taken. */
export type BlockOutcome =
	| { ok: true; message: RoomMessage }
	| {
			ok: false;
			code: BlockRefusalCode;
			reason?: string;
			fields?: BlockFields;
	  };

const refused = (
	code: BlockRefusalCode,
	reason?: string,
	fields?: BlockFields,
): BlockOutcome => ({
	ok: false,
	code,
	...(reason === undefined ? {} : { reason }),
	...(fields === undefined ? {} : { fields }),
});

/** The title the agent gave the block, which the answer's text names; the page's word for it is not trusted. */
function titleOf(block: BlockSegment): string | undefined {
	const { title } = block.data as { title?: unknown };
	return typeof title === "string" ? title : undefined;
}

/**
 * The owner's answer to an interactive block of an agent's reply, which reaches the agent only as
 * a message the owner sends (what `encodeAnswer` writes), the way typing it would. The page's
 * claim is never taken on trust: the block is found again in the stored text of a reply of the
 * room's current conversation, the answer is checked against that block, and the block takes
 * one answer, recorded before the message is sent and given up again if sending fails.
 */
export class BlockAnswering {
	readonly #deps: BlockAnsweringDeps;

	constructor(deps: BlockAnsweringDeps) {
		this.#deps = deps;
	}

	/**
	 * Answers the block `frame` names. `send` is the typed message's own path (`say`): it stores
	 * the text as the owner's message, shows it, and hands it to the host, which steers it into a
	 * running turn, queues it or starts one; it gets the message once it is stored.
	 */
	async answer(
		frame: Extract<ClientFrame, { type: "block_answer" }>,
		who: Answerer,
		send: (
			room: ChannelKey,
			text: string,
			stored: (message: RoomMessage) => void | Promise<void>,
		) => Promise<void>,
	): Promise<BlockOutcome> {
		const { rooms, log, surface } = this.#deps;
		// The agent rooms are the owners', and a message needs the actor their credential vouched for.
		if (who.tier !== "owner" || !who.actor) return refused("forbidden");
		const room = await rooms.resolve(frame.room);
		if (!room) return refused("unknown_room");
		if (room.readOnly) return refused("read_only");
		if (!surface.started) return refused("not_accepted");
		const reply = await log.answerable(room.key, frame.message);
		if (!reply) return refused("unanswerable");
		const block = parse(reply.text).find(
			(one): one is BlockSegment =>
				one.type === "block" && one.index === frame.block,
		);
		if (!block) return refused("invalid", "the message has no such block");
		const answer: Answer = {
			...frame.answer,
			...(titleOf(block) === undefined ? {} : { title: titleOf(block) }),
			ref: { block: block.index },
		};
		const checked = validateAnswer(block, answer);
		if (!checked.ok) return refused("invalid", checked.reason);
		const text = encodeAnswer(answer).trim();
		if (text.length > MAX_MESSAGE_CHARS) return refused("too_long");
		// What the agent reads is the owner's word: a line that reads as a command is never sent as one.
		if (/^[!/]/.test(text))
			return refused("invalid", "the answer would start with ! or /");
		const taken = await log.answers.take(
			room.key,
			reply.id,
			block.index,
			answer.fields,
			who.principalId,
		);
		if (!taken.created) return refused("answered", undefined, taken.fields);
		const sent: { message?: RoomMessage } = {};
		try {
			await send(room.key, text, async (message) => {
				sent.message = message;
				// Linked before the host hears of the message, so a cancel of it finds the row to release.
				await this.#link(room.key, reply.id, block.index, message.id);
			});
			if (!sent.message) throw new Error("the answer was not stored");
		} catch (error) {
			this.#deps.logger.warn(
				{ room: room.key, message: reply.id, err: error },
				"an answer to a block was not taken",
			);
			await log.answers.release(room.key, reply.id, block.index);
			return refused("not_accepted");
		}
		// The answer is sent: from here the block stays answered, whatever the bookkeeping does.
		try {
			const locked = await log.answerable(room.key, reply.id);
			if (locked) surface.showChange(locked);
		} catch (error) {
			this.#deps.logger.warn(
				{ room: room.key, message: reply.id, err: error },
				"a sent answer to a block was not shown locked",
			);
		}
		return { ok: true, message: sent.message };
	}

	/** Records which message carries the answer; a failure is logged, as the answer is sent by then and the block stays answered. */
	async #link(
		room: ChannelKey,
		message: number,
		block: number,
		answer: number,
	): Promise<void> {
		try {
			await this.#deps.log.answers.link(room, message, block, answer);
		} catch (error) {
			this.#deps.logger.warn(
				{ room, message, err: error },
				"a sent answer to a block was not linked to its message",
			);
		}
	}
}
