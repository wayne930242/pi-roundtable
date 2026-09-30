export type { AttachmentRef } from "../contract/channels.ts";

/** An attachment saved in the channel's attachment store. */
export interface StoredAttachment {
	name: string;
	/** File name inside the channel's attachment store. */
	file: string;
	/** Absolute path on the host. */
	path: string;
	contentType: string;
	size: number;
	/** True for files from the message this one replies to. */
	fromReference: boolean;
}

export interface AttachmentFailure {
	name: string;
	reason: string;
	fromReference: boolean;
}

/** An image in the form the model accepts. */
export interface ModelImage {
	data: string;
	mimeType: string;
}

/** Everything a turn carries besides its text. */
export interface TurnAttachments {
	files: StoredAttachment[];
	images: ModelImage[];
	failures: AttachmentFailure[];
}

export const NO_ATTACHMENTS: TurnAttachments = Object.freeze({
	files: [],
	images: [],
	failures: [],
}) as TurnAttachments;
