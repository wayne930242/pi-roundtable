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
	readonly files: readonly StoredAttachment[];
	readonly images: readonly ModelImage[];
	readonly failures: readonly AttachmentFailure[];
}

export const NO_ATTACHMENTS: Readonly<{
	files: readonly StoredAttachment[];
	images: readonly ModelImage[];
	failures: readonly AttachmentFailure[];
}> = Object.freeze({
	files: Object.freeze([]),
	images: Object.freeze([]),
	failures: Object.freeze([]),
});
