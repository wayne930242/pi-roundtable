import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import {
	lstat,
	mkdir,
	opendir,
	readFile,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import type { WorkspaceTrashItem, WorkspaceTrashView } from "../api-types.ts";
import type { WorkspaceGuard } from "./workspace-guard.ts";
import {
	errno,
	mapFs,
	TRASH_DIR,
	TRASH_ID,
	WorkspaceConflictError,
	WorkspaceRefusal,
} from "./workspace-model.ts";
import { moveNew } from "./workspace-move.ts";

/** The trash directory of a root, made when there is none; a link or a file in its place is refused. */
export async function trashDir(
	real: string,
	create: boolean,
): Promise<string | undefined> {
	const dir = join(real, TRASH_DIR);
	try {
		const info = await lstat(dir);
		if (!info.isDirectory()) throw new WorkspaceRefusal(403, "trash-dir");
		return dir;
	} catch (error) {
		if (error instanceof WorkspaceRefusal) throw error;
		if (errno(error) !== "ENOENT") return mapFs(error);
	}
	if (!create) return undefined;
	await mkdir(dir, { mode: 0o700 }).catch((error) => {
		if (errno(error) !== "EEXIST") mapFs(error);
	});
	const info = await lstat(dir);
	if (!info.isDirectory()) throw new WorkspaceRefusal(403, "trash-dir");
	return dir;
}

/** Moves an entry into the root's trash, with a note of where it was; it can be restored until it is purged. */
export async function removeEntry(
	guard: WorkspaceGuard,
	rootId: string,
	raw: string,
	by: string,
): Promise<WorkspaceTrashItem> {
	const located = await guard.located(rootId, raw);
	const { root, real, segments } = located;
	const parent = await guard.parentOf(located, raw);
	guard.guardWrite(located, parent, raw);
	let leaf: Stats;
	try {
		leaf = await lstat(parent.path);
	} catch (error) {
		return mapFs(error);
	}
	if (!leaf.isFile() && !leaf.isDirectory() && !leaf.isSymbolicLink())
		throw guard.refuse(root.id, raw, 403, "special");
	const trash = await trashDir(real, true);
	if (!trash) throw new WorkspaceRefusal(403, "trash-dir");
	const id = randomUUID();
	const itemDir = join(trash, id);
	await mkdir(itemDir, { mode: 0o700 });
	const kind = leaf.isDirectory()
		? "dir"
		: leaf.isSymbolicLink()
			? "symlink"
			: "file";
	const item: WorkspaceTrashItem = {
		id,
		path: segments.join("/"),
		name: parent.name,
		kind,
		size: leaf.size,
		deletedAt: new Date().toISOString(),
	};
	try {
		await rename(parent.path, join(itemDir, "item"));
		await writeFile(
			join(itemDir, "meta.json"),
			JSON.stringify({ v: 1, ...item, by }),
			{
				mode: 0o600,
			},
		);
	} catch (error) {
		// The item goes back first; the folder is removed only when it did, or the only copy would be lost.
		const back = await moveNew(
			join(itemDir, "item"),
			parent.path,
			kind === "file" ? "file" : "other",
		).then(
			() => true,
			() => false,
		);
		if (back)
			await rm(itemDir, { recursive: true, force: true }).catch(
				() => undefined,
			);
		else {
			// Left in the trash with a note of its own, so that Restore and Purge can reach it.
			await writeFile(
				join(itemDir, "meta.json"),
				JSON.stringify({ v: 1, ...item, by }),
				{ mode: 0o600 },
			).catch(() => undefined);
			guard.logger.warn(
				{ by, root: root.id, path: raw, trash: id },
				"workspace entry could not be moved back; it stays in the trash",
			);
		}
		return mapFs(error);
	}
	guard.logger.info(
		{ by, root: root.id, path: raw, trash: id },
		"workspace entry moved to the trash by an owner",
	);
	return item;
}

/** What a root's trash holds, the latest first. */
export async function listTrash(
	guard: WorkspaceGuard,
	rootId: string,
): Promise<WorkspaceTrashView> {
	const located = await guard.locate(rootId, "");
	if (located === "missing") return { items: [] };
	const dir = await trashDir(located.real, false);
	if (!dir) return { items: [] };
	const items: WorkspaceTrashItem[] = [];
	const directory = await opendir(dir);
	try {
		for await (const entry of directory) {
			if (!TRASH_ID.test(entry.name)) continue;
			try {
				const meta = JSON.parse(
					await readFile(join(dir, entry.name, "meta.json"), "utf8"),
				) as Partial<WorkspaceTrashItem>;
				if (
					meta.id === entry.name &&
					typeof meta.path === "string" &&
					typeof meta.name === "string" &&
					typeof meta.deletedAt === "string" &&
					(meta.kind === "file" ||
						meta.kind === "dir" ||
						meta.kind === "symlink")
				)
					items.push({
						id: meta.id,
						path: meta.path,
						name: meta.name,
						kind: meta.kind,
						size: typeof meta.size === "number" ? meta.size : 0,
						deletedAt: meta.deletedAt,
					});
			} catch {
				// A folder without readable notes is not something this app put there.
			}
		}
	} finally {
		await directory.close().catch(() => undefined);
	}
	return {
		items: items.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt)),
	};
}

function trashId(guard: WorkspaceGuard, rootId: string, id: string): string {
	if (!TRASH_ID.test(id)) throw guard.refuse(rootId, id, 400, "bad-path");
	return id;
}

/** Puts a trashed entry back where it was, when nothing is there now. */
export async function restoreEntry(
	guard: WorkspaceGuard,
	rootId: string,
	id: string,
	by: string,
): Promise<{ path: string }> {
	const root = guard.root(rootId);
	if (!root) throw new WorkspaceRefusal(404, "unknown-root");
	if (!root.writable) throw guard.refuse(rootId, id, 403, "read-only-root");
	trashId(guard, rootId, id);
	const located = await guard.located(rootId, "");
	const dir = await trashDir(located.real, false);
	if (!dir) throw new WorkspaceRefusal(404, "not-found");
	const itemDir = join(dir, id);
	// The folder of an item is one this code made; a link in its place is something an agent planted.
	const folder = await lstat(itemDir).catch(mapFs);
	if (!folder.isDirectory()) throw guard.refuse(rootId, id, 403, "special");
	let recorded: { path?: unknown };
	try {
		recorded = JSON.parse(await readFile(join(itemDir, "meta.json"), "utf8"));
	} catch (error) {
		return mapFs(error);
	}
	// The recorded place is only text in a file an agent could have written: it goes through
	// every check a new path does.
	const raw = typeof recorded.path === "string" ? recorded.path : "";
	const target = await guard.located(rootId, raw);
	const parent = await guard.parentOf(target, raw).catch((error) => {
		if (error instanceof WorkspaceRefusal && error.reason === "not-found")
			throw new WorkspaceConflictError("gone");
		throw error;
	});
	guard.guardWrite(target, parent, raw);
	const itemPath = join(itemDir, "item");
	let leaf: Stats;
	try {
		leaf = await lstat(itemPath);
	} catch (error) {
		return mapFs(error);
	}
	try {
		await lstat(parent.path);
		throw new WorkspaceConflictError("exists");
	} catch (error) {
		if (error instanceof WorkspaceConflictError) throw error;
		if (errno(error) !== "ENOENT") return mapFs(error);
	}
	try {
		await moveNew(itemPath, parent.path, leaf.isFile() ? "file" : "other");
	} catch (error) {
		if (errno(error) === "EEXIST") throw new WorkspaceConflictError("exists");
		return mapFs(error);
	}
	await rm(itemDir, { recursive: true, force: true });
	guard.logger.info(
		{ by, root: rootId, path: raw, trash: id },
		"workspace entry restored by an owner",
	);
	return { path: raw };
}

/** Deletes a trashed entry for good. */
export async function purgeEntry(
	guard: WorkspaceGuard,
	rootId: string,
	id: string,
	by: string,
): Promise<void> {
	const root = guard.root(rootId);
	if (!root) throw new WorkspaceRefusal(404, "unknown-root");
	if (!root.writable) throw guard.refuse(rootId, id, 403, "read-only-root");
	trashId(guard, rootId, id);
	const located = await guard.located(rootId, "");
	const dir = await trashDir(located.real, false);
	if (!dir) throw new WorkspaceRefusal(404, "not-found");
	const itemDir = join(dir, id);
	let info: Stats;
	try {
		info = await lstat(itemDir);
	} catch (error) {
		return mapFs(error);
	}
	if (!info.isDirectory()) throw new WorkspaceRefusal(404, "not-found");
	await rm(itemDir, { recursive: true, force: true });
	guard.logger.info(
		{ by, root: rootId, trash: id },
		"workspace trash item deleted for good by an owner",
	);
}
