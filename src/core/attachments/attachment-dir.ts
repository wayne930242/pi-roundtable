import { join } from "node:path";
import type { ChannelKey } from "../domain/conversation.ts";

/** A channel key as a single path segment. */
export function channelSegment(channel: ChannelKey): string {
	return channel.replace(/[^A-Za-z0-9_-]/g, "_");
}

/** Where an owner channel's attachments are saved; the runtime's read_attachment reads the same place. */
export function ownerAttachmentDir(
	dataDir: string,
	channel: ChannelKey,
): string {
	return join(dataDir, "attachments", channelSegment(channel));
}
