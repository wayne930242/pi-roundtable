import type { Stats } from "node:fs";
import { lstat, opendir, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { within } from "pi-roundtable/kit";
import type { WorkspaceEntry, WorkspaceListView } from "../api-types.ts";
import type { WorkspaceGuard } from "./workspace-guard.ts";
import {
	isTrashDir,
	LIST_MAX,
	mapFs,
	WorkspaceRefusal,
} from "./workspace-model.ts";

/** The entries of a directory under a root, folders first; a root that is not there yet lists as missing. */
export async function listDirectory(
	guard: WorkspaceGuard,
	rootId: string,
	raw: string,
): Promise<WorkspaceListView> {
	const located = await guard.locate(rootId, raw);
	if (located === "missing")
		return { path: raw, entries: [], truncated: false, missing: true };
	const { real, segments } = located;
	const target = await guard.target(located, raw);
	if (!target.info.isDirectory()) throw new WorkspaceRefusal(400, "not-a-dir");
	const entries: WorkspaceEntry[] = [];
	let truncated = false;
	const directory = await opendir(target.path).catch(mapFs);
	try {
		for await (const item of directory) {
			if (segments.length === 0 && isTrashDir(item.name)) continue;
			if (entries.length >= LIST_MAX) {
				truncated = true;
				break;
			}
			const entryPath = join(target.path, item.name);
			let info: Stats;
			try {
				info = await lstat(entryPath);
			} catch {
				continue;
			}
			const entry: WorkspaceEntry = {
				name: item.name,
				kind: info.isFile()
					? "file"
					: info.isDirectory()
						? "dir"
						: info.isSymbolicLink()
							? "symlink"
							: "other",
				size: info.size,
				mtimeMs: info.mtimeMs,
			};
			if (info.isSymbolicLink()) {
				let inside = false;
				let kind: "file" | "dir" | "other" | undefined;
				try {
					const resolved = await realpath(entryPath);
					inside = within(real, resolved);
					if (inside) {
						const targetInfo = await stat(resolved);
						kind = targetInfo.isFile()
							? "file"
							: targetInfo.isDirectory()
								? "dir"
								: "other";
					}
				} catch {
					inside = false;
				}
				entry.inside = inside;
				if (kind) entry.target = kind;
			}
			entries.push(entry);
		}
	} finally {
		await directory.close().catch(() => undefined);
	}
	entries.sort((a, b) => {
		const folder =
			Number(b.kind === "dir" || b.target === "dir") -
			Number(a.kind === "dir" || a.target === "dir");
		return folder || a.name.localeCompare(b.name, undefined, { numeric: true });
	});
	return { path: raw, entries, truncated };
}
