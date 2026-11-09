import type { Stats } from "node:fs";
import {
	link,
	lstat,
	mkdir,
	rename,
	unlink,
	writeFile,
} from "node:fs/promises";
import { within } from "pi-roundtable/kit";
import type { WorkspaceNew, WorkspaceSaved } from "../api-types.ts";
import { hashOf } from "./workspace-bytes.ts";
import type { WorkspaceGuard } from "./workspace-guard.ts";
import {
	EDIT_MAX_BYTES,
	errno,
	mapFs,
	WorkspaceConflictError,
	WorkspaceRefusal,
} from "./workspace-model.ts";

/** Makes a new file or folder where nothing is. */
export async function createEntry(
	guard: WorkspaceGuard,
	rootId: string,
	raw: string,
	body: WorkspaceNew,
	by: string,
): Promise<WorkspaceSaved> {
	const located = await guard.located(rootId, raw);
	const { root } = located;
	const text = body.text ?? "";
	if (Buffer.byteLength(text) > EDIT_MAX_BYTES)
		throw new WorkspaceRefusal(413, "text-too-large");
	const parent = await guard.parentOf(located, raw);
	guard.guardWrite(located, parent, raw);
	try {
		if (body.kind === "dir") await mkdir(parent.path, { mode: 0o755 });
		else await writeFile(parent.path, text, { flag: "wx", mode: 0o644 });
	} catch (error) {
		if (errno(error) === "EEXIST") throw new WorkspaceConflictError("exists");
		return mapFs(error);
	}
	guard.logger.info(
		{ by, root: root.id, path: raw, kind: body.kind },
		"workspace entry created by an owner",
	);
	const info = await lstat(parent.path);
	return {
		hash: body.kind === "dir" ? "" : hashOf(Buffer.from(text)),
		mtimeMs: info.mtimeMs,
		size: info.size,
	};
}

/** Moves `from` to a path that does not exist; a regular file by link and unlink, so it never replaces one. */
export async function moveNew(
	from: string,
	to: string,
	kind: "file" | "other",
): Promise<void> {
	if (kind === "file") {
		try {
			await link(from, to);
		} catch (error) {
			// A file system without hard links falls back to the check made just before.
			if (
				!["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"].includes(
					errno(error) ?? "",
				)
			)
				throw error;
			await rename(from, to);
			return;
		}
		await unlink(from);
		return;
	}
	await rename(from, to);
}

/** Renames or moves an entry to a place where nothing is, inside the same root. */
export async function renameEntry(
	guard: WorkspaceGuard,
	rootId: string,
	fromRaw: string,
	toRaw: string,
	by: string,
): Promise<void> {
	const located = await guard.located(rootId, fromRaw);
	const destination = await guard.located(rootId, toRaw);
	const { root } = located;
	const fromParent = await guard.parentOf(located, fromRaw);
	const toParent = await guard.parentOf(destination, toRaw);
	guard.guardWrite(located, fromParent, fromRaw);
	guard.guardWrite(destination, toParent, toRaw);
	let leaf: Stats;
	try {
		leaf = await lstat(fromParent.path);
	} catch (error) {
		return mapFs(error);
	}
	if (!leaf.isFile() && !leaf.isDirectory() && !leaf.isSymbolicLink())
		throw guard.refuse(root.id, fromRaw, 403, "special");
	if (leaf.isDirectory()) {
		const realFrom = fromParent.path;
		if (within(realFrom, toParent.path))
			throw new WorkspaceRefusal(400, "into-itself");
	}
	try {
		await lstat(toParent.path);
		throw new WorkspaceConflictError("exists");
	} catch (error) {
		if (error instanceof WorkspaceConflictError) throw error;
		if (errno(error) !== "ENOENT") return mapFs(error);
	}
	try {
		await moveNew(
			fromParent.path,
			toParent.path,
			leaf.isFile() ? "file" : "other",
		);
	} catch (error) {
		if (errno(error) === "EEXIST") throw new WorkspaceConflictError("exists");
		return mapFs(error);
	}
	guard.logger.info(
		{ by, root: root.id, path: fromRaw, to: toRaw },
		"workspace entry renamed by an owner",
	);
}
