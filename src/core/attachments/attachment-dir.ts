import { readdir, rm, rmdir } from "node:fs/promises";
import { join } from "node:path";
import type { ChannelKey } from "../domain/conversation.ts";

/** Where saved files wait for a turn, beside the conversations' attachment directories. */
export const STAGING = "attachments-pending";
/** Where each principal's tally of used bytes per conversation is kept. */
export const USAGE = "attachments-used";

/** The record of a saved file, in a directory next to it that no file name can be. */
export const RECORDS = ".records";

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

/** The entries of `dir`; none when it is not there. */
export async function listDir(dir: string): Promise<string[]> {
	try {
		return await readdir(dir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

/** Removes `dir` when it is empty; a directory that has entries, or is gone, stays as it is. */
export async function removeIfEmpty(dir: string): Promise<void> {
	try {
		await rmdir(dir);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "ENOTEMPTY" && code !== "EEXIST" && code !== "ENOENT")
			throw error;
	}
}

/**
 * Removes everything the core keeps for a deleted conversation: the files its turns used, the
 * files people saved for it and no turn used, and the tally of what each principal used in it.
 */
export async function discardConversationFiles(
	dataDir: string,
	channel: ChannelKey,
): Promise<void> {
	const segment = channelSegment(channel);
	await rm(ownerAttachmentDir(dataDir, channel), {
		recursive: true,
		force: true,
	});
	for (const area of [STAGING, USAGE]) {
		const root = join(dataDir, area);
		for (const principal of await listDir(root)) {
			const dir = join(root, principal);
			await rm(join(dir, segment), { recursive: true, force: true });
			await rm(join(dir, `${segment}.tmp`), { force: true });
			await removeIfEmpty(dir);
		}
	}
}
