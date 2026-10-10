import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { readdir, rename, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import {
	type AttachmentPort,
	AttachmentRefusal,
	type AttachmentUpload,
} from "../contract/attachments.ts";
import type { ConversationRegistry } from "../conversations/conversation-registry.ts";
import type {
	StoredAttachment,
	TurnAttachments,
} from "../domain/attachment.ts";
import type { Logger } from "../log.ts";
import type { ChannelKey } from "../sessions.ts";
import { channelSegment, ownerAttachmentDir } from "./attachment-dir.ts";
import { MAX_ATTACHMENT_BYTES, safeFileName } from "./attachment-fetcher.ts";
import { modelImagesOf } from "./model-images.ts";

/** Where saved files wait, beside the conversations' attachment directories. */
const STAGING = "attachments-pending";
/** The record of a saved file, in a directory next to it that no file name can be. */
export const RECORDS = ".records";

export interface AttachmentStoreOptions {
	dataDir: string;
	/** Read when used, once the host linked its services; undefined when no registry records conversations. */
	registry(): Pick<ConversationRegistry, "get"> | undefined;
	logger: Logger;
}

interface StagedRecord {
	name: string;
	contentType: string;
}

const isRecord = (value: unknown): value is StagedRecord =>
	typeof value === "object" &&
	value !== null &&
	typeof (value as StagedRecord).name === "string" &&
	typeof (value as StagedRecord).contentType === "string";

/** A principal id as one path segment; hashed, so two ids never share a directory. */
function principalSegment(principalId: string): string {
	return createHash("sha256").update(principalId).digest("hex").slice(0, 32);
}

/** Whether `file` could be a name this store gave out: one path segment that is not hidden. */
function isFileName(file: string): boolean {
	return (
		file !== "" &&
		basename(file) === file &&
		!file.startsWith(".") &&
		!file.includes("\0")
	);
}

async function listDir(dir: string): Promise<string[]> {
	try {
		return await readdir(dir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

/**
 * The files plugins take from people outside a turn. A saved file is staged under its principal and
 * its conversation until a turn uses it, then moved into the conversation's attachment directory,
 * the one `read_attachment` reads. The conversation's record decides who may stage: a private
 * conversation takes only its principal's files.
 */
export class AttachmentStore implements AttachmentPort {
	readonly #options: AttachmentStoreOptions;

	constructor(options: AttachmentStoreOptions) {
		this.#options = options;
	}

	#stagingDir(channel: ChannelKey, principalId: string): string {
		return join(
			this.#options.dataDir,
			STAGING,
			principalSegment(principalId),
			channelSegment(channel),
		);
	}

	/** Refuses a principal other than the one a private conversation belongs to. */
	async #admit(channel: ChannelKey, principalId: string): Promise<void> {
		const record = await this.#options.registry()?.get(channel);
		if (record?.visibility === "private" && record.principalId !== principalId)
			throw new AttachmentRefusal(
				"forbidden",
				`${channel} is private to someone else, so its files cannot be saved or used by ${principalId}`,
			);
	}

	async save(
		channel: ChannelKey,
		principalId: string,
		upload: AttachmentUpload,
	): Promise<StoredAttachment> {
		await this.#admit(channel, principalId);
		const size = upload.data.byteLength;
		if (size > MAX_ATTACHMENT_BYTES)
			throw new AttachmentRefusal(
				"too_large",
				`a file may be at most 25 MiB; "${upload.name}" is ${size} bytes`,
			);
		const dir = this.#stagingDir(channel, principalId);
		mkdirSync(join(dir, RECORDS), { recursive: true, mode: 0o700 });
		const file = `${crypto.randomUUID()}-${safeFileName(upload.name)}`;
		const path = join(dir, file);
		await Bun.write(path, upload.data);
		const record: StagedRecord = {
			name: upload.name,
			contentType: upload.contentType,
		};
		await Bun.write(join(dir, RECORDS, `${file}.json`), JSON.stringify(record));
		return {
			name: upload.name,
			file,
			path,
			contentType: upload.contentType,
			size,
			fromReference: false,
		};
	}

	async turnAttachments(
		channel: ChannelKey,
		principalId: string,
		files: readonly string[],
	): Promise<TurnAttachments> {
		await this.#admit(channel, principalId);
		const staging = this.#stagingDir(channel, principalId);
		const target = ownerAttachmentDir(this.#options.dataDir, channel);
		const found: StoredAttachment[] = [];
		for (const file of new Set(files)) {
			const record = await this.#recordOf(staging, file);
			if (!record)
				throw new AttachmentRefusal(
					"unknown_file",
					`no saved file "${file}" is waiting for this person in ${channel}`,
				);
			const from = join(staging, file);
			found.push({
				name: record.name,
				file,
				path: join(target, file),
				contentType: record.contentType,
				size: (await stat(from)).size,
				fromReference: false,
			});
		}
		mkdirSync(join(target, RECORDS), { recursive: true, mode: 0o700 });
		for (const stored of found) {
			try {
				await rename(join(staging, stored.file), stored.path);
			} catch (error) {
				// Another turn used the file between the check and the move.
				if ((error as NodeJS.ErrnoException).code === "ENOENT")
					throw new AttachmentRefusal(
						"unknown_file",
						`the saved file "${stored.file}" was used already`,
					);
				throw error;
			}
			await rename(
				join(staging, RECORDS, `${stored.file}.json`),
				join(target, RECORDS, `${stored.file}.json`),
			);
		}
		const { images, failures } = await modelImagesOf(
			found,
			this.#options.logger,
		);
		return { files: found, images, failures };
	}

	async remove(
		channel: ChannelKey,
		principalId: string,
		file: string,
	): Promise<boolean> {
		await this.#admit(channel, principalId);
		const staging = this.#stagingDir(channel, principalId);
		if (!(await this.#recordOf(staging, file))) return false;
		await rm(join(staging, file), { force: true });
		await rm(join(staging, RECORDS, `${file}.json`), { force: true });
		return true;
	}

	async discardPending(olderThan: Date): Promise<number> {
		const root = join(this.#options.dataDir, STAGING);
		let discarded = 0;
		for (const principal of await listDir(root)) {
			for (const channel of await listDir(join(root, principal))) {
				const dir = join(root, principal, channel);
				for (const entry of await listDir(dir)) {
					if (entry === RECORDS) continue;
					const info = await stat(join(dir, entry)).catch(() => undefined);
					if (!info || info.mtimeMs >= olderThan.getTime()) continue;
					await rm(join(dir, entry), { force: true });
					await rm(join(dir, RECORDS, `${entry}.json`), { force: true });
					discarded += 1;
				}
			}
		}
		return discarded;
	}

	async pendingBytes(principalId: string): Promise<number> {
		const root = join(
			this.#options.dataDir,
			STAGING,
			principalSegment(principalId),
		);
		let total = 0;
		for (const channel of await listDir(root)) {
			const dir = join(root, channel);
			for (const entry of await listDir(dir)) {
				if (entry === RECORDS) continue;
				total +=
					(await stat(join(dir, entry)).catch(() => undefined))?.size ?? 0;
			}
		}
		return total;
	}

	/** The record of a staged file, or undefined when it is not staged here. */
	async #recordOf(
		staging: string,
		file: string,
	): Promise<StagedRecord | undefined> {
		if (!isFileName(file)) return undefined;
		const stored = Bun.file(join(staging, RECORDS, `${file}.json`));
		if (
			!(await stored.exists()) ||
			!(await Bun.file(join(staging, file)).exists())
		)
			return undefined;
		const value: unknown = await stored.json();
		return isRecord(value) ? value : undefined;
	}
}
