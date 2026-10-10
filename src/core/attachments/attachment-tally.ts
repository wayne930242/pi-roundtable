import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** A principal id as one path segment; hashed, so two ids never share a directory. */
export function principalSegment(principalId: string): string {
	return createHash("sha256").update(principalId).digest("hex").slice(0, 32);
}

/** The bytes of a tally file; none when it is missing or unreadable as a number. */
export async function readTally(path: string): Promise<number> {
	try {
		const value = Number(await readFile(path, "utf8"));
		return Number.isFinite(value) && value > 0 ? value : 0;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
		throw error;
	}
}

/** Writes a tally whole or not at all, creating its directory if a conversation's deletion removed it meanwhile. */
export async function writeTally(path: string, bytes: number): Promise<void> {
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
 * Takes `bytes` off a tally that is there, never below zero. A tally that is gone, because the
 * conversation was deleted, stays gone: nothing here brings a deleted conversation back.
 */
export async function shrinkTally(path: string, bytes: number): Promise<void> {
	const temporary = `${path}.tmp`;
	try {
		const before = await readFile(path, "utf8");
		const value = Number(before);
		const left = Math.max(0, (Number.isFinite(value) ? value : 0) - bytes);
		await writeFile(temporary, String(left));
		await rename(temporary, path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}
