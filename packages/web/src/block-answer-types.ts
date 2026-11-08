// How the owner answers an interactive block (`options`, `suggest`, `form`, `checklist`, `review`)
// of an agent's reply, shared by the server and the page; `api-types.ts` re-exports them.

import type { AnswerKind } from "pi-better-show";
import type { RefusalCode } from "./api-types.ts";

/** The `[name, value]` pairs an answer carries, as pi-better-show's elements submit them. */
export type BlockFields = [string, string][];

/** An interactive block of a stored message the owner has answered: `block` is its index in the message (pi-better-show's `parse`), `fields` what was sent. */
export interface RoomBlockAnswer {
	block: number;
	fields: BlockFields;
}

/** What the page sends for a block: pi-better-show's `Answer` without the block's address, which the frame names, and without a title, which the server takes from the block. */
export interface BlockAnswerBody {
	kind: AnswerKind;
	fields: BlockFields;
}

/** Why an answer to a block was refused, besides the reasons any frame is refused for. */
export type BlockRefusalCode =
	| RefusalCode
	/** The block was answered already; `fields` are the earlier answer. */
	| "answered"
	/** The message is no agent reply of the room's current conversation, so it takes no answer. */
	| "unanswerable"
	/** The answer does not fit the block, or its text could not be sent as the owner's message; `reason` says why. */
	| "invalid";
