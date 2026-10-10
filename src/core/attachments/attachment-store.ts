import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
	type AttachmentPort,
	AttachmentRefusal,
	type AttachmentUpload,
	type TurnAttachmentOptions,
} from "../contract/attachments.ts";
import type { ConversationRegistry } from "../conversations/conversation-registry.ts";
import type {
	StoredAttachment,
	TurnAttachments,
} from "../domain/attachment.ts";
import type { Logger } from "../log.ts";
import type { ChannelKey } from "../sessions.ts";
import {
	channelSegment,
	listDir,
	ownerAttachmentDir,
	removeIfEmpty,
	STAGING,
	USAGE,
} from "./attachment-dir.ts";
import { MAX_ATTACHMENT_BYTES, safeFileName } from "./attachment-fetcher.ts";
import { isAttachmentName } from "./attachment-name.ts";
import { modelImagesOf } from "./model-images.ts";

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

/** The bytes of a tally file; none when it is missing or unreadable as a number. */
async function readTally(path: string): Promise<number> {
	try {
		const value = Number(await readFile(path, "utf8"));
		return Number.isFinite(value) && value > 0 ? value : 0;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
		throw error;
	}
}

/** Writes a tally whole or not at all, creating its directory if a conversation's deletion removed it meanwhile. */
async function writeTally(path: string, bytes: number): Promise<void> {
	const temporary = `${path}.tmp`;
	try {
		await writeFile(temporary, String(bytes));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		await mkdir(dirname(path), { recursive: true, mode: 0o700 });
		await writeFile(temporary, String(bytes));
	}
	await rename(temporary, path);
}

/**
 * The files plugins take from people outside a turn. A saved file is staged under its principal and
 * its conversation until a turn uses it, then moved into the conversation's attachment directory,
 * the one `read_attachment` reads. The conversation's record decides who may stage: a private
 * conversation takes only its principal's files.
 *
 * Calls that change one principal's files run one after another, so two messages of one person
 * never see each other half done; the tally of the bytes a principal used per conversation lives
 * beside the staging directories.
 */
export class AttachmentStore implements AttachmentPort {
	readonly #options: AttachmentStoreOptions;
	/** The last call queued for each principal, which the next one waits for. */
	readonly #tails = new Map<string, Promise<void>>();

	constructor(options: AttachmentStoreOptions) {
		this.#options = options;
	}

	/** Runs `run` after the principal's earlier calls, whether they succeeded or not. */
	#exclusive<T>(principal: string, run: () => Promise<T>): Promise<T> {
		const result = (this.#tails.get(principal) ?? Promise.resolve()).then(run);
		const tail = result.then(
			() => undefined,
			() => undefined,
		);
		this.#tails.set(principal, tail);
		void tail.then(() => {
			if (this.#tails.get(principal) === tail) this.#tails.delete(principal);
		});
		return result;
	}

	#stagingDir(channel: ChannelKey, principalId: string): string {
		return join(
			this.#options.dataDir,
			STAGING,
			principalSegment(principalId),
			channelSegment(channel),
		);
	}

	#tallyDir(principalId: string): string {
		return join(this.#options.dataDir, USAGE, principalSegment(principalId));
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
		const file = `${crypto.randomUUID()}-${safeFileName(upload.name)}`;
		const path = join(dir, file);
		const recordPath = join(dir, RECORDS, `${file}.json`);
		const record: StagedRecord = {
			name: upload.name,
			contentType: upload.contentType,
		};
		await this.#exclusive(principalSegment(principalId), async () => {
			mkdirSync(join(dir, RECORDS), { recursive: true, mode: 0o700 });
			try {
				await Bun.write(path, upload.data);
				await Bun.write(recordPath, JSON.stringify(record));
			} catch (error) {
				// A file without its record could never be used or removed, yet would count as waiting.
				await rm(path, { force: true });
				await rm(recordPath, { force: true });
				throw error;
			}
		});
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
		options: TurnAttachmentOptions = {},
	): Promise<TurnAttachments> {
		await this.#admit(channel, principalId);
		const found = await this.#exclusive(principalSegment(principalId), () =>
			this.#claim(channel, principalId, files, options),
		);
		const { images, failures } = await modelImagesOf(
			found,
			this.#options.logger,
		);
		return { files: found, images, failures };
	}

	/** Checks every file, then moves them all into the conversation, or none when any step fails. */
	async #claim(
		channel: ChannelKey,
		principalId: string,
		files: readonly string[],
		options: TurnAttachmentOptions,
	): Promise<StoredAttachment[]> {
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
			found.push({
				name: record.name,
				file,
				path: join(target, file),
				contentType: record.contentType,
				size: (await stat(join(staging, file))).size,
				fromReference: false,
			});
		}
		const added = found.reduce((sum, stored) => sum + stored.size, 0);
		const tally = join(this.#tallyDir(principalId), channelSegment(channel));
		const before = await readTally(tally);
		if (options.usedBytesLimit !== undefined) {
			const used = await this.#usedBytes(principalId);
			if (used + added > options.usedBytesLimit)
				throw new AttachmentRefusal(
					"quota_exceeded",
					`the files already used in turns hold ${used} bytes, and ${added} more would pass the limit of ${options.usedBytesLimit} bytes`,
				);
		}
		mkdirSync(join(target, RECORDS), { recursive: true, mode: 0o700 });
		mkdirSync(this.#tallyDir(principalId), { recursive: true, mode: 0o700 });
		const moved: StoredAttachment[] = [];
		try {
			for (const stored of found) {
				await rename(join(staging, stored.file), stored.path);
				moved.push(stored);
				await rename(
					join(staging, RECORDS, `${stored.file}.json`),
					join(target, RECORDS, `${stored.file}.json`),
				);
			}
			await writeTally(tally, before + added);
		} catch (error) {
			await this.#putBack(moved, staging, target, tally, before);
			// Something else took the file between the check and the move.
			if ((error as NodeJS.ErrnoException).code === "ENOENT")
				throw new AttachmentRefusal(
					"unknown_file",
					"a saved file was used or discarded while the message was taken",
				);
			throw error;
		}
		return found;
	}

	/** Undoes a partial move: the files return to staging and the tally to what it was. */
	async #putBack(
		moved: readonly StoredAttachment[],
		staging: string,
		target: string,
		tally: string,
		before: number,
	): Promise<void> {
		for (const stored of moved) {
			await rename(stored.path, join(staging, stored.file)).catch(
				() => undefined,
			);
			await rename(
				join(target, RECORDS, `${stored.file}.json`),
				join(staging, RECORDS, `${stored.file}.json`),
			).catch(() => undefined);
		}
		await writeTally(tally, before).catch(() => undefined);
	}

	async remove(
		channel: ChannelKey,
		principalId: string,
		file: string,
	): Promise<boolean> {
		await this.#admit(channel, principalId);
		const staging = this.#stagingDir(channel, principalId);
		return this.#exclusive(principalSegment(principalId), async () => {
			if (!(await this.#recordOf(staging, file))) return false;
			await rm(join(staging, file), { force: true });
			await rm(join(staging, RECORDS, `${file}.json`), { force: true });
			return true;
		});
	}

	async discardPending(olderThan: Date): Promise<number> {
		const root = join(this.#options.dataDir, STAGING);
		let discarded = 0;
		for (const principal of await listDir(root)) {
			discarded += await this.#exclusive(principal, async () => {
				let count = 0;
				for (const channel of await listDir(join(root, principal))) {
					const dir = join(root, principal, channel);
					for (const entry of await listDir(dir)) {
						if (entry === RECORDS) continue;
						const info = await stat(join(dir, entry)).catch(() => undefined);
						if (!info || info.mtimeMs >= olderThan.getTime()) continue;
						await rm(join(dir, entry), { force: true });
						await rm(join(dir, RECORDS, `${entry}.json`), { force: true });
						count += 1;
					}
					// A conversation with nothing waiting keeps no directory.
					await removeIfEmpty(join(dir, RECORDS));
					await removeIfEmpty(dir);
				}
				await removeIfEmpty(join(root, principal));
				return count;
			});
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

	/** The bytes the principal's turns used, across their conversations. */
	async #usedBytes(principalId: string): Promise<number> {
		const dir = this.#tallyDir(principalId);
		let total = 0;
		for (const channel of await listDir(dir))
			if (!channel.endsWith(".tmp"))
				total += await readTally(join(dir, channel));
		return total;
	}

	/** The record of a staged file, or undefined when it is not staged here. */
	async #recordOf(
		staging: string,
		file: string,
	): Promise<StagedRecord | undefined> {
		if (!isAttachmentName(file)) return undefined;
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
