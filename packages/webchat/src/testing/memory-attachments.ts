import {
	type AttachmentPort,
	AttachmentRefusal,
	type ChannelKey,
	type StoredAttachment,
} from "pi-roundtable";

interface Staged {
	principalId: string;
	channel: ChannelKey;
	stored: StoredAttachment;
	savedAt: number;
}

/**
 * The attachment port in memory: a saved file waits for its principal in its channel, a turn uses
 * it once, and `discardPending` drops what is older than the date. `clock` stamps saved files.
 */
export function memoryAttachments(
	clock: () => number = Date.now,
): AttachmentPort & {
	staged: Map<string, Staged>;
	used: StoredAttachment[];
} {
	const staged = new Map<string, Staged>();
	const used: StoredAttachment[] = [];
	let counter = 0;
	return {
		staged,
		used,
		save: async (channel, principalId, upload) => {
			counter += 1;
			const file = `f${counter}-${upload.name}`;
			const stored: StoredAttachment = {
				name: upload.name,
				file,
				path: `/memory/${file}`,
				contentType: upload.contentType,
				size: upload.data.byteLength,
				fromReference: false,
			};
			staged.set(file, { principalId, channel, stored, savedAt: clock() });
			return stored;
		},
		turnAttachments: async (channel, principalId, files) => {
			const found = files.map((file) => {
				const entry = staged.get(file);
				if (
					!entry ||
					entry.principalId !== principalId ||
					entry.channel !== channel
				)
					throw new AttachmentRefusal(
						"unknown_file",
						`no saved file "${file}"`,
					);
				return entry.stored;
			});
			for (const file of files) staged.delete(file);
			used.push(...found);
			return { files: found, images: [], failures: [] };
		},
		remove: async (channel, principalId, file) => {
			const entry = staged.get(file);
			if (
				!entry ||
				entry.principalId !== principalId ||
				entry.channel !== channel
			)
				return false;
			return staged.delete(file);
		},
		discardPending: async (olderThan) => {
			let dropped = 0;
			for (const [file, entry] of staged)
				if (entry.savedAt < olderThan.getTime()) {
					staged.delete(file);
					dropped += 1;
				}
			return dropped;
		},
		pendingBytes: async (principalId) =>
			[...staged.values()]
				.filter((entry) => entry.principalId === principalId)
				.reduce((sum, entry) => sum + entry.stored.size, 0),
	};
}
