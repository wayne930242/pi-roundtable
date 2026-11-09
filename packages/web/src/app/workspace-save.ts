import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { lstat, open, realpath, rename, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { within } from "pi-roundtable/kit";
import type { WorkspaceSave, WorkspaceSaved } from "../api-types.ts";
import { classify, hashOf } from "./workspace-bytes.ts";
import type { WorkspaceGuard } from "./workspace-guard.ts";
import {
	EDIT_MAX_BYTES,
	errno,
	mapFs,
	WorkspaceConflictError,
	type WorkspaceFilesOptions,
	WorkspaceRefusal,
} from "./workspace-model.ts";

/** Replaces a file's text when it is still the version the writer read: a temporary file beside it, checked twice, then renamed over it. */
export async function saveFile(
	guard: WorkspaceGuard,
	hooks: NonNullable<WorkspaceFilesOptions["hooks"]>,
	rootId: string,
	raw: string,
	body: WorkspaceSave,
	by: string,
): Promise<WorkspaceSaved> {
	const located = await guard.located(rootId, raw);
	const { root } = located;
	if (Buffer.byteLength(body.text) > EDIT_MAX_BYTES)
		throw new WorkspaceRefusal(413, "text-too-large");
	const parent = await guard.parentOf(located, raw);
	guard.guardWrite(located, parent, raw);
	let leaf: Stats;
	try {
		leaf = await lstat(parent.path);
	} catch (error) {
		if (errno(error) === "ENOENT") throw new WorkspaceConflictError("gone");
		return mapFs(error);
	}
	if (leaf.isSymbolicLink()) throw guard.refuse(root.id, raw, 403, "symlink");
	if (!leaf.isFile()) throw guard.refuse(root.id, raw, 403, "special");
	const current = await guard.readCurrent(parent.path, leaf, root.id, raw);
	const kind = classify(current.bytes);
	if (kind.binary) throw new WorkspaceRefusal(403, "binary");
	if (kind.notUtf8) throw new WorkspaceRefusal(403, "not-utf8");
	const from = hashOf(current.bytes);
	if (from !== body.baseHash)
		throw new WorkspaceConflictError("changed", {
			hash: from,
			mtimeMs: current.mtimeMs,
			size: current.bytes.byteLength,
		});
	const payload = Buffer.concat([
		kind.bom ? Buffer.from([0xef, 0xbb, 0xbf]) : Buffer.alloc(0),
		Buffer.from(body.text, "utf8"),
	]);
	const tmp = join(
		parent.dir,
		`.${parent.name.slice(0, 100)}.rt-${randomUUID()}.tmp`,
	);
	let handle: FileHandle | undefined;
	let created: { dev: number; ino: number } | undefined;
	try {
		handle = await open(tmp, "wx", current.mode);
		await handle.chmod(current.mode);
		await handle.writeFile(payload);
		await handle.sync();
		const tmpInfo = await handle.stat();
		created = { dev: tmpInfo.dev, ino: tmpInfo.ino };
		await hooks.beforeReplace?.(tmp, parent.path);
		// The directory is the one that was checked, the file is still a regular file, and nobody
		// changed it while the temporary file was written.
		let again: string;
		try {
			again = await realpath(dirname(tmp));
		} catch {
			throw guard.refuse(root.id, raw, 403, "outside");
		}
		if (again !== parent.dir || !within(located.real, again))
			throw guard.refuse(root.id, raw, 403, "outside");
		let leafNow: Stats;
		try {
			leafNow = await lstat(parent.path);
		} catch (error) {
			if (errno(error) === "ENOENT") throw new WorkspaceConflictError("gone");
			return mapFs(error);
		}
		if (leafNow.isSymbolicLink())
			throw guard.refuse(root.id, raw, 403, "symlink");
		if (!leafNow.isFile()) throw guard.refuse(root.id, raw, 403, "special");
		const latest = await guard.readCurrent(parent.path, leafNow, root.id, raw);
		const now = hashOf(latest.bytes);
		if (now !== body.baseHash)
			throw new WorkspaceConflictError("changed", {
				hash: now,
				mtimeMs: latest.mtimeMs,
				size: latest.bytes.byteLength,
			});
		await rename(tmp, parent.path);
	} catch (error) {
		await discard(tmp, created, handle);
		throw error instanceof WorkspaceRefusal ||
			error instanceof WorkspaceConflictError
			? error
			: mapFs(error);
	} finally {
		await handle?.close().catch(() => undefined);
	}
	const info = await stat(parent.path);
	const to = hashOf(payload);
	guard.logger.info(
		{
			by,
			root: root.id,
			path: raw,
			bytes: payload.byteLength,
			from: from.slice(0, 12),
			to: to.slice(0, 12),
		},
		"workspace file saved by an owner",
	);
	return { hash: to, mtimeMs: info.mtimeMs, size: payload.byteLength };
}

/**
 * Removes a temporary file. When its directory can no longer be found at the same place (it
 * was moved away), the file is emptied through its handle instead, so no text stays behind.
 */
async function discard(
	tmp: string,
	created: { dev: number; ino: number } | undefined,
	handle: FileHandle | undefined,
): Promise<void> {
	let here = false;
	try {
		const info = await lstat(tmp);
		here =
			created !== undefined &&
			info.ino === created.ino &&
			info.dev === created.dev;
	} catch {
		here = false;
	}
	if (here) await unlink(tmp).catch(() => undefined);
	else if (created) await handle?.truncate(0).catch(() => undefined);
	else await unlink(tmp).catch(() => undefined);
}
