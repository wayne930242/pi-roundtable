import type {
	StoredAttachment,
	TurnAttachments,
} from "../domain/attachment.ts";
import type { ChannelKey } from "../sessions.ts";

/** A file a plugin hands the core to keep for a conversation. */
export interface AttachmentUpload {
	/** The name the person gave it; shown to the model and kept as is. */
	name: string;
	contentType: string;
	data: Uint8Array;
}

/** Why the attachment store refused a call. */
export type AttachmentRefusalCode =
	/** The conversation is private to someone else. */
	| "forbidden"
	/** No saved file of that name is waiting for this person in this conversation. */
	| "unknown_file"
	/** The file is over the core's limit of 25 MiB. */
	| "too_large"
	/** Using the files would take the principal past the `usedBytesLimit` the plugin passed. */
	| "quota_exceeded";

/** An attachment call the store refused; `code` says why, and the plugin decides what its client sees. */
export class AttachmentRefusal extends Error {
	override name = "AttachmentRefusal";
	readonly code: AttachmentRefusalCode;

	constructor(code: AttachmentRefusalCode, message: string) {
		super(message);
		this.code = code;
	}
}

/** What a plugin asks of `turnAttachments` besides the files. */
export interface TurnAttachmentOptions {
	/**
	 * The most bytes the principal may have used in turns across all their conversations, these
	 * files included. A call that would pass it is refused with `quota_exceeded` and moves nothing.
	 * Without it the core sets no limit; deleting a conversation gives its bytes back.
	 */
	usedBytesLimit?: number;
}

/**
 * Files a plugin takes from a person outside a turn, such as an upload over HTTP, kept for the
 * conversation until a turn uses them. A saved file waits for its person: only the principal that
 * saved it may use it, in the conversation it was saved for. A private conversation refuses every
 * other principal; a shared one lets each use their own. Using a file moves it into the
 * conversation's attachment directory, where the turn's `read_attachment` and
 * `ToolTurn.attachment()` find it. Calls reject with `AttachmentRefusal` for a refused call, and
 * throw a PluginError when the host has no `dataDir`.
 *
 * Who may use a channel is the plugin's to check, not the port's. The port refuses another
 * principal only in a conversation the host's registry records as private to someone else; for a
 * channel the registry does not know, or when the host has no registry, it admits every principal.
 * A plugin whose channel key comes from a person must first check that the channel is that
 * person's, as the web chat does before every call; the plugin that owns a channel checks it,
 * because only that plugin knows what the channel is.
 */
export interface AttachmentPort {
	/** Keeps a file for the principal in the conversation until a turn uses it. */
	save(
		channel: ChannelKey,
		principalId: string,
		upload: AttachmentUpload,
	): Promise<StoredAttachment>;
	/**
	 * The turn's attachments for files `save` returned: each moves into the conversation, up to four
	 * images are prepared for the model, and every file is named in the turn's `## Attachments`
	 * block. Refuses the whole set when one file is unknown or already used, or when
	 * `options.usedBytesLimit` would be passed; none moves then, however many calls run at once.
	 */
	turnAttachments(
		channel: ChannelKey,
		principalId: string,
		files: readonly string[],
		options?: TurnAttachmentOptions,
	): Promise<TurnAttachments>;
	/** Discards a saved file no turn used; false when there is none. */
	remove(
		channel: ChannelKey,
		principalId: string,
		file: string,
	): Promise<boolean>;
	/** Discards every saved file no turn used that was saved before `olderThan`; returns how many. */
	discardPending(olderThan: Date): Promise<number>;
	/** The bytes the principal has saved that no turn used yet, across their conversations. */
	pendingBytes(principalId: string): Promise<number>;
}
