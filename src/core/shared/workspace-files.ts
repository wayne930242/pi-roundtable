import { readFile, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";

/** Where a session may read files by path: its shared workspace and its scratch dir. */
export interface WorkspaceRoots {
	workspace: string;
	scratchDir?: string;
}

/** A file refused by path; its message names the path and is safe to show the model. */
export class WorkspaceFileError extends Error {
	override name = "WorkspaceFileError";
}

/** A local file found inside the roots, not read yet. */
export interface WorkspaceFile {
	/** The path as the caller gave it. */
	path: string;
	/** Where it resolves, symlinks followed. */
	realPath: string;
	/** Its base name, the default name it is sent under. */
	name: string;
	size: number;
}

/** Whether `child` is `parent` or inside it. */
function within(parent: string, child: string): boolean {
	const rel = relative(parent, child);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function realRoot(root: string): Promise<string | undefined> {
	return realpath(root).catch(() => undefined);
}

/**
 * Finds a regular file by path, relative paths against the workspace, and refuses one that does
 * not resolve inside the workspace or the scratch dir, so a symlink counts by its target.
 */
export async function findWorkspaceFile(
	path: string,
	roots: WorkspaceRoots,
): Promise<WorkspaceFile> {
	const given = resolve(roots.workspace, path);
	let real: string;
	try {
		real = await realpath(given);
	} catch {
		throw new WorkspaceFileError(`${path} does not exist.`);
	}
	const allowed = await Promise.all(
		[roots.workspace, roots.scratchDir]
			.filter((root): root is string => root !== undefined)
			.map(realRoot),
	);
	if (!allowed.some((root) => root !== undefined && within(root, real)))
		throw new WorkspaceFileError(
			`${path} is outside the workspace${roots.scratchDir ? " and the scratch dir" : ""}; only files inside ${roots.scratchDir ? "them" : "it"} can be sent.`,
		);
	const info = await stat(real);
	if (!info.isFile()) throw new WorkspaceFileError(`${path} is not a file.`);
	return { path, realPath: real, name: basename(given), size: info.size };
}

/** Reads a file `findWorkspaceFile` found; a file that grew past `maxBytes` since is refused. */
export async function readWorkspaceFile(
	file: WorkspaceFile,
	maxBytes: number,
): Promise<Uint8Array> {
	const data = new Uint8Array(await readFile(file.realPath));
	if (data.byteLength > maxBytes)
		throw new WorkspaceFileError(
			`${file.path} is ${data.byteLength} bytes, over the ${maxBytes} allowed.`,
		);
	return data;
}
