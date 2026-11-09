import { constants } from "node:fs";
import type { Logger } from "pi-roundtable";
import type { WorkspaceSaved } from "../api-types.ts";

/** Entries one directory lists before it says there are more. */
export const LIST_MAX = 2000;
/** The largest file the pane shows with its text (and highlights): 2 MiB. */
export const VIEW_MAX_BYTES = 2 * 1024 * 1024;
/** The largest file, and text, the pane edits and saves: 1 MiB. */
export const EDIT_MAX_BYTES = 1024 * 1024;
/** The largest file the download route sends: 50 MiB. */
export const DOWNLOAD_MAX_BYTES = 50 * 1024 * 1024;
/** The longest path the pane takes, in bytes. */
const PATH_MAX_BYTES = 4096;
/** How much of a file's start tells binary from text, and an image by its signature. */
export const HEAD_BYTES = 8192;
/** The directory of each root that holds what was deleted. */
export const TRASH_DIR = ".rt-trash";
const GIT_DIR = ".git";

/** The guarded names are compared without case and in compatibility form (`ſ` is `s` on some volumes): a volume that ignores it takes `.GIT` for `.git`. */
export const isGitDir = (name: string): boolean =>
	name.normalize("NFKC").toLowerCase() === GIT_DIR;
export const isTrashDir = (name: string | undefined): boolean =>
	name?.normalize("NFKC").toLowerCase() === TRASH_DIR;
export const TRASH_ID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const ROOT_ID = /^[a-z][a-z0-9-]{0,31}$/;
export const OPEN_READ =
	constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

/** A place whose files the pane shows. */
export interface WorkspaceRoot {
	id: string;
	label: string;
	/** An absolute directory; it may not exist yet. */
	dir: string;
	writable: boolean;
}

/** Why a request was refused; each reason has its own wording and status in the routes. */
export type WorkspaceReason =
	| "bad-path"
	| "unknown-root"
	| "not-found"
	| "not-a-dir"
	| "is-a-dir"
	| "is-root"
	| "outside"
	| "special"
	| "symlink"
	| "read-only-root"
	| "git-dir"
	| "trash-dir"
	| "binary"
	| "not-utf8"
	| "too-large"
	| "text-too-large"
	| "into-itself"
	| "cross-device"
	| "permission";

/** A request the pane refuses; `status` is the HTTP answer. */
export class WorkspaceRefusal extends Error {
	override name = "WorkspaceRefusal";
	constructor(
		readonly status: number,
		readonly reason: WorkspaceReason,
	) {
		super(reason);
	}
}

/** A write that does not fit the file as it is: changed since the writer read it, gone, or already there. */
export class WorkspaceConflictError extends Error {
	override name = "WorkspaceConflictError";
	constructor(
		readonly conflict: "changed" | "gone" | "exists",
		readonly current?: WorkspaceSaved,
	) {
		super(conflict);
	}
}

export interface WorkspaceFilesOptions {
	roots: readonly WorkspaceRoot[];
	logger: Logger;
	/** The host's own directories (data, keys): a root that first appears as a link to one is refused. */
	protectedDirs?: readonly string[];
	/** For tests: runs after a save's temporary file is written and before the checks that precede the rename. */
	hooks?: {
		beforeReplace?: (tmp: string, target: string) => void | Promise<void>;
	};
}

/** A path under a root: the segments, or a refusal. */
export function parsePath(raw: string): string[] {
	if (
		typeof raw !== "string" ||
		raw.includes("\0") ||
		raw.startsWith("/") ||
		Buffer.byteLength(raw) > PATH_MAX_BYTES
	)
		throw new WorkspaceRefusal(400, "bad-path");
	if (raw === "") return [];
	const segments = raw.split("/");
	if (segments.some((s) => s === "" || s === "." || s === ".."))
		throw new WorkspaceRefusal(400, "bad-path");
	return segments;
}

export const errno = (error: unknown): string | undefined =>
	(error as { code?: string } | undefined)?.code;

/** An fs failure as the refusal it means, or the failure itself. */
export function mapFs(error: unknown): never {
	if (
		error instanceof WorkspaceRefusal ||
		error instanceof WorkspaceConflictError
	)
		throw error;
	switch (errno(error)) {
		case "ENOENT":
			throw new WorkspaceRefusal(404, "not-found");
		case "ENOTDIR":
			throw new WorkspaceRefusal(404, "not-found");
		case "ELOOP":
			throw new WorkspaceRefusal(403, "symlink");
		case "EACCES":
		case "EPERM":
		case "EROFS":
			throw new WorkspaceRefusal(403, "permission");
		case "EXDEV":
			throw new WorkspaceRefusal(400, "cross-device");
		case "ENAMETOOLONG":
			throw new WorkspaceRefusal(400, "bad-path");
		default:
			throw error;
	}
}
