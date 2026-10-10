import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExpiredAttachments } from "../contract/attachments.ts";
import { listDir, RECORDS, USAGE } from "./attachment-dir.ts";
import { isAttachmentName } from "./attachment-name.ts";
import { shrinkTally } from "./attachment-tally.ts";

/** What the core records about a file a turn used; the first two come from its upload. */
export interface UsedRecord {
	name: string;
	contentType: string;
	/** The owner's directory segment (a hash, never the id), when the core recorded it. */
	principal?: string;
	/** When the turn took the file, in epoch milliseconds. */
	usedAt?: number;
	size?: number;
}

/** What stays of a record once its file is removed: when, and nothing the person named. */
interface ExpiredMark {
	expiredAt: number;
}

/** The record file of `file` in a conversation's attachment directory. */
export function recordPath(dir: string, file: string): string {
	return join(dir, RECORDS, `${file}.json`);
}

/** The record as parsed, or undefined when there is none or it is not an object. */
async function readRecord(path: string): Promise<unknown> {
	try {
		return JSON.parse(await readFile(path, "utf8"));
	} catch (error) {
		if (error instanceof SyntaxError) return undefined;
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

const isExpiredMark = (value: unknown): value is ExpiredMark =>
	typeof value === "object" &&
	value !== null &&
	typeof (value as ExpiredMark).expiredAt === "number";

const isUsedRecord = (value: unknown): value is UsedRecord =>
	typeof value === "object" &&
	value !== null &&
	!isExpiredMark(value) &&
	typeof (value as UsedRecord).name === "string";

/** Whether the file's retention period ended and the core removed it. */
export async function wasExpired(dir: string, file: string): Promise<boolean> {
	if (!isAttachmentName(file)) return false;
	return isExpiredMark(await readRecord(recordPath(dir, file)));
}

/** What a tool or the model reads for a file removed after its retention period. */
export const expiredMessage = (shown: string): string =>
	`"${shown}" was removed after its retention period and cannot be read any more. Ask the person to attach it again.`;

export interface ExpiryDeps {
	dataDir: string;
	now(): number;
	/** Runs after the principal's earlier calls, as every call that changes their files does. */
	exclusive<T>(principal: string, run: () => Promise<T>): Promise<T>;
}

/** A used file the sweep found old, with the owner it could tell. */
interface Candidate {
	channel: string;
	file: string;
}

/** Whoever the owner of an unowned record could only be: a lone tally in the conversation, else none. */
async function soleHolders(
	dataDir: string,
): Promise<Map<string, string | null>> {
	const holders = new Map<string, string | null>();
	const root = join(dataDir, USAGE);
	for (const principal of await listDir(root))
		for (const entry of await listDir(join(root, principal))) {
			if (entry.endsWith(".tmp")) continue;
			holders.set(entry, holders.has(entry) ? null : principal);
		}
	return holders;
}

/** The used files older than `cutoff`, grouped by the owner whose calls they run with. */
async function findOld(
	dataDir: string,
	cutoff: number,
): Promise<Map<string, Candidate[]>> {
	const holders = await soleHolders(dataDir);
	const groups = new Map<string, Candidate[]>();
	const root = join(dataDir, "attachments");
	for (const channel of await listDir(root)) {
		const dir = join(root, channel);
		for (const entry of await listDir(join(dir, RECORDS))) {
			if (!entry.endsWith(".json")) continue;
			const file = entry.slice(0, -".json".length);
			const record = await readRecord(recordPath(dir, file));
			if (!isUsedRecord(record)) continue;
			const usedAt =
				record.usedAt ??
				(await stat(join(dir, file)).catch(() => undefined))?.mtimeMs;
			if (usedAt === undefined || usedAt >= cutoff) continue;
			const owner = record.principal ?? holders.get(channel) ?? "";
			groups.set(owner, [...(groups.get(owner) ?? []), { channel, file }]);
		}
	}
	return groups;
}

/**
 * Removes the files turns used before `now - olderThanMs`. Each owner's files go in one call that
 * runs with their other calls: the file, then its record (which becomes a mark that keeps no
 * name), then the bytes off their tally for the conversation, so a failure part way leaves a
 * tally that is too high, never too low.
 */
export async function expireUsedFiles(
	deps: ExpiryDeps,
	olderThanMs: number,
): Promise<ExpiredAttachments> {
	const { dataDir } = deps;
	const cutoff = deps.now() - olderThanMs;
	const total: ExpiredAttachments = {
		files: 0,
		bytes: 0,
		unattributedBytes: 0,
	};
	for (const [owner, candidates] of await findOld(dataDir, cutoff)) {
		await deps.exclusive(owner || "unattributed", async () => {
			const removed = new Map<string, number>();
			for (const { channel, file } of candidates) {
				const dir = join(dataDir, "attachments", channel);
				const path = recordPath(dir, file);
				const record = await readRecord(path);
				// A turn may have deleted the conversation, or an earlier call this one.
				if (!isUsedRecord(record)) continue;
				const info = await stat(join(dir, file)).catch(() => undefined);
				const size = info?.size ?? record.size ?? 0;
				const usedAt = record.usedAt ?? info?.mtimeMs;
				if (usedAt === undefined || usedAt >= cutoff) continue;
				await rm(join(dir, file), { force: true });
				const mark: ExpiredMark = { expiredAt: deps.now() };
				if (!(await writeMark(path, mark))) continue;
				total.files += 1;
				total.bytes += size;
				if (owner === "") total.unattributedBytes += size;
				else removed.set(channel, (removed.get(channel) ?? 0) + size);
			}
			for (const [channel, bytes] of removed)
				await shrinkTally(join(dataDir, USAGE, owner, channel), bytes);
		});
	}
	return total;
}

/** Replaces a record by its mark; false when the conversation's directory is gone. */
async function writeMark(path: string, mark: ExpiredMark): Promise<boolean> {
	const temporary = `${path}.tmp`;
	try {
		await writeFile(temporary, JSON.stringify(mark));
		await rename(temporary, path);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}
