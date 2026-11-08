import { useSyncExternalStore } from "react";
import type {
	BlockAnswerBody,
	BlockFields,
	BlockRefusalCode,
	ServerFrame,
} from "../../src/api-types.ts";
import type { BlockScope } from "./block-scope.ts";
import { frameListeners } from "./frame-taps.ts";
import type { AppConnection } from "./socket.ts";

/** The server's word on an answer: taken, or refused for `code` (`answered` brings what answered the block). */
export type BlockReply =
	| { ok: true }
	| {
			ok: false;
			code: BlockRefusalCode;
			reason?: string | undefined;
			fields?: BlockFields | undefined;
	  };

/** A block on its way, or answered from this page before the server's record reached it. */
export type BlockCell =
	| { state: "pending" }
	| { state: "done"; fields: BlockFields };

const cells = new Map<string, BlockCell>();
const listeners = new Set<() => void>();

const changed = () => {
	for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
	listeners.add(listener);
	return () => listeners.delete(listener);
};

/** The key of one block of one stored message. */
export const cellKey = (scope: BlockScope, block: number): string =>
	`${scope.message.room}\0${scope.message.id}\0${block}`;

/** The state of a block on this page; every drawing of the block follows it, so a redraw does not find a block on its way open. */
export function useBlockCell(key: string | undefined): BlockCell | undefined {
	return useSyncExternalStore(subscribe, () =>
		key === undefined ? undefined : cells.get(key),
	);
}

/** Marks the block as on its way: false when it already is, or is answered. */
export function pendBlock(key: string): boolean {
	if (cells.has(key)) return false;
	cells.set(key, { state: "pending" });
	changed();
	return true;
}

/** Marks the block as answered with these fields. */
export function lockBlock(key: string, fields: BlockFields): void {
	cells.set(key, { state: "done", fields });
	changed();
}

/** The answer did not go: the block is open again. */
export function reopenBlock(key: string): void {
	if (cells.delete(key)) changed();
}

/** Forgets every cell, for tests. */
export function resetBlockCells(): void {
	cells.clear();
	changed();
}

/** How long an answer waits for the server's word before it is taken for lost. */
const REPLY_MS = 20_000;

/**
 * Sends the owner's answer to an interactive block of a stored reply and resolves with the
 * server's word: taken (`accepted`), or why not (`block_refused`, or the `refused` of a frame the
 * server could not take at all). A socket that closes while the answer waits, or one never open,
 * is a refusal as not accepted; the page reads the room again on reconnect and finds the lock if
 * the server did take it.
 */
export function answerBlock(
	connection: Pick<AppConnection, "send" | "open">,
	scope: BlockScope,
	block: number,
	answer: BlockAnswerBody,
): Promise<BlockReply> {
	const id = crypto.randomUUID();
	return new Promise((resolve) => {
		const lost: BlockReply = { ok: false, code: "not_accepted" };
		const finish = (reply: BlockReply) => {
			frameListeners.delete(listen);
			clearInterval(watch);
			clearTimeout(limit);
			resolve(reply);
		};
		const listen = (frame: ServerFrame) => {
			if (frame.type === "accepted" && frame.id === id) finish({ ok: true });
			else if (frame.type === "refused" && frame.id === id)
				finish({ ok: false, code: frame.code });
			else if (frame.type === "block_refused" && frame.id === id)
				finish({
					ok: false,
					code: frame.code,
					reason: frame.reason,
					fields: frame.fields,
				});
		};
		const watch = setInterval(() => {
			if (!connection.open) finish(lost);
		}, 500);
		const limit = setTimeout(() => finish(lost), REPLY_MS);
		frameListeners.add(listen);
		const sent = connection.send({
			type: "block_answer",
			id,
			room: scope.message.room,
			message: scope.message.id,
			block,
			answer,
		});
		if (!sent) finish(lost);
	});
}
