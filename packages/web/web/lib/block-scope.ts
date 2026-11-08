import { createContext } from "react";
import type { RoomMessage } from "../../src/api-types.ts";

/**
 * What a stored agent reply tells the interactive blocks in it: the message (its recorded answers
 * lock their blocks) and whether a block still open may be answered here, which holds in a reply of
 * the room's current conversation, in a room that takes messages.
 */
export interface BlockScope {
	message: RoomMessage;
	open: boolean;
}

/** Set around the text of a stored message; the blocks of a live, pending or foreign text have none and take no answer. Only an agent's reply counts (see `AnswerBlock`). */
export const BlockScopeContext = createContext<BlockScope | undefined>(
	undefined,
);
