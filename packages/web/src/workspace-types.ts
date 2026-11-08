import type { ApiError } from "./api-common-types.ts";

// ── The workspace files pane ───────────────────────────────────────────────────────────────────

/** A place whose files the pane shows; the client names it by `id`, never by a path. */
export interface WorkspaceRootView {
	id: string;
	label: string;
	writable: boolean;
}

/** `GET api/workspace`. */
export interface WorkspaceRootsView {
	roots: WorkspaceRootView[];
}

export type WorkspaceEntryKind = "file" | "dir" | "symlink" | "other";

export interface WorkspaceEntry {
	name: string;
	kind: WorkspaceEntryKind;
	size: number;
	mtimeMs: number;
	/** For a symlink: whether its target lies inside the root. Outside, it is shown and never opened. */
	inside?: boolean;
	/** For a symlink inside the root: what it points to. */
	target?: "file" | "dir" | "other";
}

/** `GET api/workspace/<root>/list?path=`. */
export interface WorkspaceListView {
	path: string;
	entries: WorkspaceEntry[];
	/** The directory held more than the 2,000 entries listed. */
	truncated: boolean;
	/** The root's directory does not exist (yet); the app never creates it. */
	missing?: boolean;
}

/** Why a file cannot be edited. */
export type WorkspaceReadOnlyReason =
	| "read-only-root"
	| "git-dir"
	| "trash"
	| "symlink"
	| "binary"
	| "too-large"
	| "not-utf8";

/** The language a file's highlighting is loaded for. */
export type WorkspaceLanguage =
	| "typescript"
	| "javascript"
	| "json"
	| "markdown"
	| "css"
	| "html"
	| "python"
	| "yaml"
	| "go"
	| "rust"
	| "sql"
	| "xml"
	| "shell"
	| "toml"
	| "dockerfile"
	| "plain";

/** `GET api/workspace/<root>/file?path=`. */
export interface WorkspaceFileView {
	path: string;
	size: number;
	mtimeMs: number;
	/** SHA-256 of the file's bytes, in hex; a save carries it back as `baseHash`. */
	hash: string;
	editable: boolean;
	reason?: WorkspaceReadOnlyReason;
	binary: boolean;
	/** Over the 2 MiB the pane highlights: metadata and download only. */
	tooLarge: boolean;
	/** The line separator the file mostly uses. */
	eol: "\n" | "\r\n";
	/** The file starts with a UTF-8 byte order mark, which the text leaves out and a save puts back. */
	bom: boolean;
	language: WorkspaceLanguage;
	/** What the browser can show of the file from the `raw` route: a picture, a PDF, a sound or a video. */
	media?: WorkspaceMedia;
	/** The file's text, as written (its separators kept); absent for a binary or too large file. */
	text?: string;
}

/** The kinds of file the pane previews; the `raw` route serves each with a type from an allowlist. */
export type WorkspaceMedia = "image" | "pdf" | "audio" | "video";

/** `PUT api/workspace/<root>/file?path=` body. */
export interface WorkspaceSave {
	text: string;
	baseHash: string;
}

/** What a write answers: the file now. */
export interface WorkspaceSaved {
	hash: string;
	mtimeMs: number;
	size: number;
}

/** A 409: the file is not as the writer saw it. */
export interface WorkspaceConflict extends ApiError {
	conflict: "changed" | "gone" | "exists";
	/** The file as it is now, for `changed`. */
	current?: WorkspaceSaved;
}

/** An error body that names its cause. */
export interface WorkspaceRefusalBody extends ApiError {
	reason: string;
}

/** `POST api/workspace/<root>/new?path=` body. */
export interface WorkspaceNew {
	kind: "file" | "dir";
	/** A new file's first text; default empty. */
	text?: string;
}

/** `POST api/workspace/<root>/rename` body. */
export interface WorkspaceRename {
	from: string;
	to: string;
}

/** One thing in a root's trash. */
export interface WorkspaceTrashItem {
	id: string;
	/** Where it was, relative to the root. */
	path: string;
	name: string;
	kind: "file" | "dir" | "symlink";
	size: number;
	/** ISO 8601, the server's clock. */
	deletedAt: string;
}

/** `GET api/workspace/<root>/trash`. */
export interface WorkspaceTrashView {
	items: WorkspaceTrashItem[];
}
