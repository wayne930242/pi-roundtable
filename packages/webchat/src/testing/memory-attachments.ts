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
 * it once, `discardPending` drops what is older than the date, and `expireUsed` drops the used files
 * older than the age. `clock` stamps saved and used files.
 */
export function memoryAttachments(
	clock: () => number = Date.now,
): Required<AttachmentPort> & {
	staged: Map<string, Staged>;
	used: StoredAttachment[];
} {
	const staged = new Map<string, Staged>();
	const used: StoredAttachment[] = [];
	const owners = new Map<string, string>();
	const usedAt = new Map<string, number>();
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
		turnAttachments: async (channel, principalId, files, options) => {
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
			const taken = used
				.filter((stored) => owners.get(stored.file) === principalId)
				.reduce((sum, stored) => sum + stored.size, 0);
			const added = found.reduce((sum, stored) => sum + stored.size, 0);
			if (
				options?.usedBytesLimit !== undefined &&
				taken + added > options.usedBytesLimit
			)
				throw new AttachmentRefusal("quota_exceeded", "over the used limit");
			for (const file of files) staged.delete(file);
			for (const stored of found) {
				owners.set(stored.file, principalId);
				usedAt.set(stored.file, clock());
			}
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
		expireUsed: async ({ olderThanMs }) => {
			const result = { files: 0, bytes: 0, unattributedBytes: 0 };
			for (const [index, stored] of used.entries().toArray().reverse()) {
				if ((usedAt.get(stored.file) ?? 0) >= clock() - olderThanMs) continue;
				used.splice(index, 1);
				owners.delete(stored.file);
				usedAt.delete(stored.file);
				result.files += 1;
				result.bytes += stored.size;
			}
			return result;
		},
		pendingBytes: async (principalId) =>
			[...staged.values()]
				.filter((entry) => entry.principalId === principalId)
				.reduce((sum, entry) => sum + entry.stored.size, 0),
	};
}
