import { existsSync, mkdirSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";

/**
 * Moves a session directory's conversations into `archive/<time>/`, so the next session
 * opened there starts with no history. Pi only reads `.jsonl` files at the directory's top
 * level. Returns how many were moved.
 */
export function archiveSessions(dir: string, now = new Date()): number {
	if (!existsSync(dir)) return 0;
	const files = readdirSync(dir).filter((file) => file.endsWith(".jsonl"));
	if (files.length === 0) return 0;
	const target = join(dir, "archive", now.toISOString().replaceAll(":", "-"));
	mkdirSync(target, { recursive: true });
	for (const file of files) renameSync(join(dir, file), join(target, file));
	return files.length;
}
