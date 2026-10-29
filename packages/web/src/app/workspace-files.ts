import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { constants, realpathSync, type Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import {
	link,
	lstat,
	mkdir,
	open,
	opendir,
	readFile,
	realpath,
	rename,
	rm,
	stat,
	unlink,
	writeFile,
} from "node:fs/promises";
import {
	basename,
	dirname,
	isAbsolute,
	join,
	relative,
	resolve,
	sep,
} from "node:path";
import { Readable } from "node:stream";
import type { Logger } from "pi-roundtable";
import { PluginError } from "pi-roundtable";
import { within } from "pi-roundtable/kit";
import type {
	WorkspaceEntry,
	WorkspaceFileView,
	WorkspaceLanguage,
	WorkspaceListView,
	WorkspaceMedia,
	WorkspaceNew,
	WorkspaceReadOnlyReason,
	WorkspaceRootView,
	WorkspaceSave,
	WorkspaceSaved,
	WorkspaceTrashItem,
	WorkspaceTrashView,
} from "../api-types.ts";
import { safeName } from "./files.ts";

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
const HEAD_BYTES = 8192;
/** The directory of each root that holds what was deleted. */
export const TRASH_DIR = ".rt-trash";
const GIT_DIR = ".git";

/** The guarded names are compared without case and in compatibility form (`ſ` is `s` on some volumes): a volume that ignores it takes `.GIT` for `.git`. */
const isGitDir = (name: string): boolean =>
	name.normalize("NFKC").toLowerCase() === GIT_DIR;
const isTrashDir = (name: string | undefined): boolean =>
	name?.normalize("NFKC").toLowerCase() === TRASH_DIR;
const TRASH_ID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ROOT_ID = /^[a-z][a-z0-9-]{0,31}$/;
const OPEN_READ =
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

/** The real directory of a path that may not exist: its nearest existing ancestor, resolved, plus the rest. */
function realish(path: string): string {
	const rest: string[] = [];
	let current = resolve(path);
	for (;;) {
		try {
			return join(realpathSync(current), ...rest.reverse());
		} catch {
			const parent = dirname(current);
			if (parent === current) return resolve(path);
			rest.push(basename(current));
			current = parent;
		}
	}
}

/**
 * Checks the roots a host configured, once at the start: each id a short lower-case word and
 * given once, each directory absolute, and none of them the host's data directory or a directory
 * that contains it (that holds the sessions, keys and credentials), symlinks resolved.
 */
export function checkRoots(
	roots: readonly WorkspaceRoot[],
	protectedDirs: readonly string[],
): void {
	const seen = new Set<string>();
	const guarded = protectedDirs.map(realish);
	for (const root of roots) {
		if (!ROOT_ID.test(root.id))
			throw new PluginError(
				`pi-roundtable-web: workspace root id ${JSON.stringify(root.id)} must be a lower-case word such as agents`,
			);
		if (seen.has(root.id))
			throw new PluginError(
				`pi-roundtable-web: workspace root id ${root.id} is used twice`,
			);
		seen.add(root.id);
		if (!isAbsolute(root.dir))
			throw new PluginError(
				`pi-roundtable-web: workspace root ${root.id} must be an absolute directory, not ${JSON.stringify(root.dir)}`,
			);
		const real = realish(root.dir);
		for (const dir of guarded) {
			if (real === dir)
				throw new PluginError(
					`pi-roundtable-web: workspace root ${root.id} is ${dir}, which holds the host's data and keys; choose a directory inside it or beside it`,
				);
			if (within(real, dir))
				throw new PluginError(
					`pi-roundtable-web: workspace root ${root.id} (${real}) contains ${dir}, which holds the host's data and keys; choose a narrower directory`,
				);
		}
	}
}

const hashOf = (data: Uint8Array): string =>
	createHash("sha256").update(data).digest("hex");

const BY_EXTENSION: Record<string, WorkspaceLanguage> = {
	ts: "typescript",
	tsx: "typescript",
	mts: "typescript",
	cts: "typescript",
	js: "javascript",
	jsx: "javascript",
	mjs: "javascript",
	cjs: "javascript",
	json: "json",
	jsonc: "json",
	json5: "json",
	md: "markdown",
	markdown: "markdown",
	mdx: "markdown",
	css: "css",
	scss: "css",
	html: "html",
	htm: "html",
	py: "python",
	pyi: "python",
	yml: "yaml",
	yaml: "yaml",
	go: "go",
	rs: "rust",
	sql: "sql",
	xml: "xml",
	svg: "xml",
	plist: "xml",
	sh: "shell",
	bash: "shell",
	zsh: "shell",
	toml: "toml",
};

const BY_NAME: Record<string, WorkspaceLanguage> = {
	dockerfile: "dockerfile",
	containerfile: "dockerfile",
	".bashrc": "shell",
	".zshrc": "shell",
	".profile": "shell",
	".bash_profile": "shell",
	".gitignore": "plain",
};

/** The language to highlight a file in, from its name. */
export function languageOf(name: string): WorkspaceLanguage {
	const lower = name.toLowerCase();
	const byName = BY_NAME[lower];
	if (byName) return byName;
	if (lower.startsWith("dockerfile.")) return "dockerfile";
	const dot = lower.lastIndexOf(".");
	return dot <= 0 ? "plain" : (BY_EXTENSION[lower.slice(dot + 1)] ?? "plain");
}

/** What a request says about the version and the part it wants. */
export interface RawConditions {
	/** The `Range` header. */
	range?: string | null | undefined;
	/** The `If-Range` header: the part is sent only when this is still the file's ETag. */
	ifRange?: string | null | undefined;
	/** The `If-None-Match` header. */
	ifNoneMatch?: string | null | undefined;
}

/** Whether an `If-None-Match` names this ETag (weakly, as a GET compares) or is `*`. */
function matchesEtag(header: string | null | undefined, etag: string): boolean {
	if (!header) return false;
	const bare = (tag: string) => tag.trim().replace(/^W\//, "");
	return header
		.split(",")
		.some((tag) => tag.trim() === "*" || bare(tag) === bare(etag));
}

/**
 * One plain byte range (`a-b`, `a-` or `-n`) of a file of `size` bytes; anything else is not a range
 * and the whole file is sent, which a server may always do. A start past the end is unsatisfiable.
 */
function parseRange(
	header: string | null | undefined,
	size: number,
): { start: number; end: number } | "unsatisfiable" | undefined {
	const match = /^bytes=(\d*)-(\d*)$/.exec(header ?? "");
	if (!match || (match[1] === "" && match[2] === "")) return undefined;
	const first = match[1] === "" ? undefined : Number(match[1]);
	const last = match[2] === "" ? undefined : Number(match[2]);
	if (first === undefined) {
		const tail = last ?? 0;
		if (tail === 0) return "unsatisfiable";
		return { start: Math.max(0, size - tail), end: size - 1 };
	}
	if (last !== undefined && last < first) return undefined;
	if (first >= size) return "unsatisfiable";
	return { start: first, end: Math.min(last ?? size - 1, size - 1) };
}

const startsWith = (head: Uint8Array, offset: number, text: string): boolean =>
	[...text].every((char, i) => head[offset + i] === char.charCodeAt(0));
const startsWithBytes = (head: Uint8Array, bytes: number[]): boolean =>
	bytes.every((byte, i) => head[i] === byte);
/** An ISO base media file (MP4, M4A, MOV, AVIF): `ftyp` after a four-byte size. */
const hasFtyp = (head: Uint8Array): boolean => startsWith(head, 4, "ftyp");

/** What a preview shows and the type the route answers with; the type comes from here, never from the file. */
interface MediaType {
	kind: WorkspaceMedia;
	type: string;
	/** Whether the file's first bytes are those of the kind its name claims. */
	is(head: Uint8Array): boolean;
}

const RIFF_WAVE = (head: Uint8Array) =>
	startsWith(head, 0, "RIFF") && startsWith(head, 8, "WAVE");
const EBML = (head: Uint8Array) =>
	startsWithBytes(head, [0x1a, 0x45, 0xdf, 0xa3]);
const JPEG = (head: Uint8Array) => startsWithBytes(head, [0xff, 0xd8, 0xff]);
const OGG = (head: Uint8Array) => startsWith(head, 0, "OggS");
const MP4 = (type: string, kind: "audio" | "video"): MediaType => ({
	kind,
	type,
	is: hasFtyp,
});

/** By extension; a name alone never previews, the bytes must agree. SVG alone has no signature. */
const MEDIA_BY_EXTENSION: Record<string, MediaType> = {
	png: {
		kind: "image",
		type: "image/png",
		is: (head) =>
			startsWithBytes(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
	},
	jpg: { kind: "image", type: "image/jpeg", is: JPEG },
	jpeg: { kind: "image", type: "image/jpeg", is: JPEG },
	gif: {
		kind: "image",
		type: "image/gif",
		is: (head) =>
			startsWith(head, 0, "GIF87a") || startsWith(head, 0, "GIF89a"),
	},
	webp: {
		kind: "image",
		type: "image/webp",
		is: (head) => startsWith(head, 0, "RIFF") && startsWith(head, 8, "WEBP"),
	},
	avif: {
		kind: "image",
		type: "image/avif",
		is: (head) =>
			hasFtyp(head) &&
			(startsWith(head, 8, "avif") || startsWith(head, 8, "avis")),
	},
	bmp: {
		kind: "image",
		type: "image/bmp",
		is: (head) => startsWith(head, 0, "BM"),
	},
	ico: {
		kind: "image",
		type: "image/x-icon",
		is: (head) =>
			startsWithBytes(head, [0, 0, 1, 0]) ||
			startsWithBytes(head, [0, 0, 2, 0]),
	},
	svg: {
		kind: "image",
		type: "image/svg+xml",
		is: (head) =>
			!head.includes(0) &&
			Buffer.from(head).toString("latin1").includes("<svg"),
	},
	pdf: {
		kind: "pdf",
		type: "application/pdf",
		is: (head) => Buffer.from(head.subarray(0, 1024)).includes("%PDF-"),
	},
	mp3: {
		kind: "audio",
		type: "audio/mpeg",
		is: (head) =>
			startsWith(head, 0, "ID3") ||
			(head[0] === 0xff && ((head[1] ?? 0) & 0xe0) === 0xe0),
	},
	m4a: MP4("audio/mp4", "audio"),
	aac: {
		kind: "audio",
		type: "audio/aac",
		is: (head) => head[0] === 0xff && ((head[1] ?? 0) & 0xf0) === 0xf0,
	},
	ogg: { kind: "audio", type: "audio/ogg", is: OGG },
	opus: { kind: "audio", type: "audio/ogg", is: OGG },
	wav: { kind: "audio", type: "audio/wav", is: RIFF_WAVE },
	flac: {
		kind: "audio",
		type: "audio/flac",
		is: (head) => startsWith(head, 0, "fLaC"),
	},
	weba: { kind: "audio", type: "audio/webm", is: EBML },
	mp4: MP4("video/mp4", "video"),
	m4v: MP4("video/mp4", "video"),
	mov: MP4("video/quicktime", "video"),
	webm: { kind: "video", type: "video/webm", is: EBML },
};

const RASTER_BY_SIGNATURE = ["png", "jpg", "gif", "webp"] as const;

/** The preview a file is, by its first bytes for the four common pictures and by name and bytes for the rest. */
function mediaOf(name: string, head: Uint8Array): MediaType | undefined {
	for (const extension of RASTER_BY_SIGNATURE) {
		const found = MEDIA_BY_EXTENSION[extension];
		if (found?.is(head)) return found;
	}
	const dot = name.lastIndexOf(".");
	if (dot <= 0) return undefined;
	const found = MEDIA_BY_EXTENSION[name.slice(dot + 1).toLowerCase()];
	return found?.is(head) ? found : undefined;
}

/** Extensions that a browser would run or render as a page: always downloads. */
const ACTIVE = new Set(["html", "htm", "xhtml", "xml", "xsl", "mht"]);

/**
 * What a preview may load: an image or a sound from the place itself. A picture, a sound and a video
 * are sandboxed, so nothing in them runs even when the address is opened on its own; a PDF is not,
 * because the browser's viewer does not run under a sandbox.
 */
const MEDIA_POLICY =
	"sandbox; frame-ancestors 'self'; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'";
const PDF_POLICY =
	"frame-ancestors 'self'; default-src 'none'; style-src 'unsafe-inline'; img-src data:";

// The byte order mark is stripped by hand, once: a second one is text and stays.
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** What a file's bytes are, for the view and for a save. */
function classify(bytes: Uint8Array): {
	binary: boolean;
	text?: string;
	bom: boolean;
	eol: "\n" | "\r\n";
	notUtf8: boolean;
} {
	const head = bytes.subarray(0, HEAD_BYTES);
	const base = { bom: false, eol: "\n" as const };
	if (head.includes(0)) return { ...base, binary: true, notUtf8: false };
	const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
	let text: string;
	try {
		text = decoder.decode(bom ? bytes.subarray(3) : bytes);
	} catch {
		return { ...base, binary: false, notUtf8: true };
	}
	let crlf = 0;
	let lf = 0;
	for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1))
		if (text[i - 1] === "\r") crlf++;
		else lf++;
	return {
		binary: false,
		notUtf8: false,
		text,
		bom,
		eol: crlf > lf ? "\r\n" : "\n",
	};
}

/** A path under a root: the segments, or a refusal. */
function parsePath(raw: string): string[] {
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

const errno = (error: unknown): string | undefined =>
	(error as { code?: string } | undefined)?.code;

/** An fs failure as the refusal it means, or the failure itself. */
function mapFs(error: unknown): never {
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

interface Located {
	root: WorkspaceRoot;
	/** The real directory of the root. */
	real: string;
	segments: string[];
}

/** A parent directory, resolved and checked to lie inside the root. */
interface Parent {
	/** The real directory the leaf is in. */
	dir: string;
	/** The leaf's name. */
	name: string;
	/** Path of the leaf under the real parent. */
	path: string;
	/** The real parent relative to the real root. */
	relative: string[];
}

/**
 * The owner's view of the files in some directories, with the rules that keep it inside them.
 * Every request names a root by id and a path relative to it; the path is checked as text first,
 * then each directory it passes through is resolved and must be inside the real root, and a file
 * is opened without following a link, its handle compared with what was checked. A write goes to
 * a temporary file in the same directory and replaces the original by rename.
 */
export class WorkspaceFiles {
	readonly #roots: Map<string, WorkspaceRoot>;
	readonly #logger: Logger;
	readonly #hooks: NonNullable<WorkspaceFilesOptions["hooks"]>;
	/** Where each root really was when it was first seen; a root that resolves elsewhere later is refused. */
	readonly #pinned = new Map<string, string>();
	readonly #guarded: readonly string[];
	readonly #speaker = new AsyncLocalStorage<string>();

	constructor(options: WorkspaceFilesOptions) {
		this.#roots = new Map(options.roots.map((root) => [root.id, root]));
		this.#guarded = (options.protectedDirs ?? []).map(realish);
		for (const root of options.roots) {
			try {
				this.#pinned.set(root.id, realpathSync(root.dir));
			} catch {
				// A root that is not there yet is pinned where it first appears.
			}
		}
		this.#logger = options.logger;
		this.#hooks = options.hooks ?? {};
	}

	/** Runs `run` so that what it refuses is logged with who asked. */
	speaking<T>(by: string, run: () => Promise<T>): Promise<T> {
		return this.#speaker.run(by, run);
	}

	roots(): WorkspaceRootView[] {
		return [...this.#roots.values()].map(({ id, label, writable }) => ({
			id,
			label,
			writable,
		}));
	}

	#refuse(
		rootId: string,
		path: string,
		status: number,
		reason: WorkspaceReason,
	): WorkspaceRefusal {
		this.#logger.warn(
			{
				by: this.#speaker.getStore(),
				root: rootId,
				path: path.slice(0, 200),
				reason,
			},
			"workspace path refused",
		);
		return new WorkspaceRefusal(status, reason);
	}

	/** The root and the path's segments, checked as text only; no file is touched. */
	async #locate(rootId: string, raw: string): Promise<Located | "missing"> {
		const root = this.#roots.get(rootId);
		if (!root) throw new WorkspaceRefusal(404, "unknown-root");
		let segments: string[];
		try {
			segments = parsePath(raw);
		} catch (error) {
			if (error instanceof WorkspaceRefusal)
				throw this.#refuse(rootId, raw, error.status, error.reason);
			throw error;
		}
		let real: string;
		try {
			real = await realpath(root.dir);
		} catch {
			return "missing";
		}
		const pinned = this.#pinned.get(root.id);
		if (pinned === undefined) {
			// A root missing at the start is pinned where it first appears, under the start-time rule.
			if (this.#guarded.some((dir) => real === dir || within(real, dir)))
				throw this.#refuse(root.id, raw, 403, "outside");
			this.#pinned.set(root.id, real);
		} else if (pinned !== real)
			throw this.#refuse(root.id, raw, 403, "outside");
		return { root, real, segments };
	}

	async #located(rootId: string, raw: string): Promise<Located> {
		const located = await this.#locate(rootId, raw);
		if (located === "missing") throw new WorkspaceRefusal(404, "not-found");
		return located;
	}

	/** Resolves the directory a leaf is in and refuses one that leaves the root. */
	async #parentOf(located: Located, raw: string): Promise<Parent> {
		const { real, root, segments } = located;
		const name = segments.at(-1);
		if (name === undefined) throw new WorkspaceRefusal(400, "is-root");
		let dir: string;
		try {
			dir = await realpath(join(real, ...segments.slice(0, -1)));
		} catch (error) {
			return mapFs(error);
		}
		if (!within(real, dir)) throw this.#refuse(root.id, raw, 403, "outside");
		return {
			dir,
			name,
			path: join(dir, name),
			relative: relative(real, dir).split(sep).filter(Boolean),
		};
	}

	/** A write is refused in a read-only root, in `.git` and in the trash, by name and by where the parent really is. */
	#guardWrite(located: Located, parent: Parent | undefined, raw: string): void {
		const { root, segments } = located;
		if (!root.writable) throw this.#refuse(root.id, raw, 403, "read-only-root");
		const names = [...segments, ...(parent?.relative ?? [])];
		if (names.some(isGitDir)) throw this.#refuse(root.id, raw, 403, "git-dir");
		if (isTrashDir(segments[0]) || isTrashDir(parent?.relative[0]))
			throw this.#refuse(root.id, raw, 403, "trash-dir");
	}

	/** Opens a regular file without following a link; the handle must be the file that was checked. */
	async #openRegular(
		path: string,
		checked: { dev: number; ino: number },
		rootId: string,
		raw: string,
	): Promise<FileHandle> {
		let handle: FileHandle;
		try {
			handle = await open(path, OPEN_READ);
		} catch (error) {
			if (errno(error) === "ELOOP")
				throw this.#refuse(rootId, raw, 403, "symlink");
			return mapFs(error);
		}
		const info = await handle.stat();
		if (
			!info.isFile() ||
			info.dev !== checked.dev ||
			info.ino !== checked.ino
		) {
			await handle.close();
			throw this.#refuse(rootId, raw, 403, "special");
		}
		return handle;
	}

	/**
	 * Where a file read really is, and its stat: a link inside the root is followed to its target,
	 * a link to the outside is refused, anything that is not a file or folder is refused.
	 */
	async #target(
		located: Located,
		raw: string,
	): Promise<{ path: string; info: Stats; viaLink: boolean }> {
		const { root, real, segments } = located;
		if (segments.length === 0)
			return { path: real, info: await stat(real), viaLink: false };
		const parent = await this.#parentOf(located, raw);
		let leaf: Stats;
		try {
			leaf = await lstat(parent.path);
		} catch (error) {
			return mapFs(error);
		}
		let path = parent.path;
		let viaLink = false;
		if (leaf.isSymbolicLink()) {
			viaLink = true;
			try {
				path = await realpath(parent.path);
			} catch (error) {
				if (errno(error) === "ENOENT")
					throw this.#refuse(root.id, raw, 403, "outside");
				return mapFs(error);
			}
			if (!within(real, path)) throw this.#refuse(root.id, raw, 403, "outside");
		}
		let info: Stats;
		try {
			info = await stat(path);
		} catch (error) {
			return mapFs(error);
		}
		if (!info.isFile() && !info.isDirectory())
			throw this.#refuse(root.id, raw, 403, "special");
		return { path, info, viaLink };
	}

	async list(rootId: string, raw: string): Promise<WorkspaceListView> {
		const located = await this.#locate(rootId, raw);
		if (located === "missing")
			return { path: raw, entries: [], truncated: false, missing: true };
		const { real, segments } = located;
		const target = await this.#target(located, raw);
		if (!target.info.isDirectory())
			throw new WorkspaceRefusal(400, "not-a-dir");
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
			return (
				folder || a.name.localeCompare(b.name, undefined, { numeric: true })
			);
		});
		return { path: raw, entries, truncated };
	}

	/** Reads a regular file whole, up to `limit` bytes; one that has grown past it is a refusal. */
	async #readAll(
		handle: FileHandle,
		size: number,
		limit: number,
	): Promise<Uint8Array> {
		if (size > limit) throw new WorkspaceRefusal(403, "too-large");
		const buffer = Buffer.allocUnsafe(Math.min(size, limit) + 1);
		let filled = 0;
		for (;;) {
			const { bytesRead } = await handle.read(
				buffer,
				filled,
				buffer.length - filled,
				filled,
			);
			if (bytesRead === 0) break;
			filled += bytesRead;
			if (filled === buffer.length)
				throw new WorkspaceRefusal(403, "too-large");
		}
		return buffer.subarray(0, filled);
	}

	async read(rootId: string, raw: string): Promise<WorkspaceFileView> {
		const located = await this.#located(rootId, raw);
		const { root, segments } = located;
		const target = await this.#target(located, raw);
		if (target.info.isDirectory()) throw new WorkspaceRefusal(400, "is-a-dir");
		const handle = await this.#openRegular(
			target.path,
			target.info,
			root.id,
			raw,
		);
		try {
			const info = await handle.stat();
			const head = Buffer.alloc(Math.min(HEAD_BYTES, info.size));
			await handle.read(head, 0, head.length, 0);
			const name = segments.at(-1) ?? "";
			const media = mediaOf(name, head);
			const view: WorkspaceFileView = {
				path: raw,
				size: info.size,
				mtimeMs: info.mtimeMs,
				hash: "",
				editable: false,
				binary: false,
				tooLarge: info.size > VIEW_MAX_BYTES,
				eol: "\n",
				bom: false,
				language: languageOf(name),
				...(media ? { media: media.kind } : {}),
			};
			let reason = this.#whyReadOnly(located, target.viaLink, raw);
			if (view.tooLarge) {
				view.binary = head.includes(0);
				view.reason = reason ?? (view.binary ? "binary" : "too-large");
				return view;
			}
			const bytes = await this.#readAll(handle, info.size, VIEW_MAX_BYTES);
			view.hash = hashOf(bytes);
			const kind = classify(bytes);
			view.binary = kind.binary;
			view.bom = kind.bom;
			view.eol = kind.eol;
			if (kind.text !== undefined) view.text = kind.text;
			reason ??= kind.binary
				? "binary"
				: kind.notUtf8
					? "not-utf8"
					: info.size > EDIT_MAX_BYTES
						? "too-large"
						: undefined;
			if (reason) view.reason = reason;
			else view.editable = true;
			return view;
		} finally {
			await handle.close();
		}
	}

	/** The structural reason a file is not editable, if there is one. */
	#whyReadOnly(
		located: Located,
		viaLink: boolean,
		_raw: string,
	): WorkspaceReadOnlyReason | undefined {
		const { root, segments } = located;
		if (viaLink) return "symlink";
		if (!root.writable) return "read-only-root";
		if (segments.some(isGitDir)) return "git-dir";
		if (isTrashDir(segments[0])) return "trash";
		return undefined;
	}

	async raw(
		rootId: string,
		raw: string,
		download: boolean,
		conditions: RawConditions = {},
	): Promise<Response> {
		const located = await this.#located(rootId, raw);
		const { root, segments } = located;
		const target = await this.#target(located, raw);
		if (target.info.isDirectory()) throw new WorkspaceRefusal(400, "is-a-dir");
		if (target.info.size > DOWNLOAD_MAX_BYTES)
			throw new WorkspaceRefusal(413, "too-large");
		const handle = await this.#openRegular(
			target.path,
			target.info,
			root.id,
			raw,
		);
		try {
			const info = await handle.stat();
			const head = Buffer.alloc(Math.min(HEAD_BYTES, info.size));
			await handle.read(head, 0, head.length, 0);
			const name = segments.at(-1) ?? "file";
			const media = mediaOf(name, head);
			const extension = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
			const asText =
				!media && !head.includes(0) && !ACTIVE.has(extension) && !download;
			const inline = !download && (media !== undefined || asText);
			const encoded = encodeURIComponent(safeName(name)).replace(
				/['()*]/g,
				(char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
			);
			// The size is what the open handle says now, and the stream stops there, so a file that
			// grows while it is sent cannot make the body longer than its `content-length`.
			if (info.size > DOWNLOAD_MAX_BYTES)
				throw new WorkspaceRefusal(413, "too-large");
			// Strong, so that `If-Range` may match it: the inode and the time to the nanosecond.
			const exact = await handle.stat({ bigint: true });
			const etag = `"${exact.ino.toString(16)}-${exact.size.toString(16)}-${exact.mtimeNs.toString(16)}"`;
			const headers: Record<string, string> = {
				"content-type": media
					? media.type
					: asText
						? "text/plain; charset=utf-8"
						: "application/octet-stream",
				"content-disposition": inline
					? "inline"
					: `attachment; filename*=UTF-8''${encoded}`,
				"content-security-policy": media
					? media.kind === "pdf"
						? PDF_POLICY
						: MEDIA_POLICY
					: "sandbox; frame-ancestors 'self'; default-src 'none'",
				"x-content-type-options": "nosniff",
				"accept-ranges": "bytes",
			};
			if (media && inline) {
				// A preview may be asked for again, in pieces: it is checked each time, never kept as is.
				headers["cache-control"] = "no-store";
				headers.etag = etag;
				headers["last-modified"] = new Date(info.mtimeMs).toUTCString();
			} else headers["cache-control"] = "no-store";
			if (media && inline && matchesEtag(conditions.ifNoneMatch, etag)) {
				await handle.close();
				return new Response(null, { status: 304, headers });
			}
			let start = 0;
			let end = info.size - 1;
			let status = 200;
			const range =
				info.size > 0 && (!conditions.ifRange || conditions.ifRange === etag)
					? parseRange(conditions.range, info.size)
					: undefined;
			if (range === "unsatisfiable") {
				await handle.close();
				headers["content-range"] = `bytes */${info.size}`;
				headers["content-length"] = "0";
				return new Response(null, { status: 416, headers });
			}
			if (range) {
				({ start, end } = range);
				status = 206;
				headers["content-range"] = `bytes ${start}-${end}/${info.size}`;
			}
			headers["content-length"] = String(info.size === 0 ? 0 : end - start + 1);
			let body: ReadableStream<Uint8Array> | null = null;
			if (info.size === 0) await handle.close();
			else
				body = Readable.toWeb(
					handle.createReadStream({ start, end, autoClose: true }),
				) as ReadableStream<Uint8Array>;
			return new Response(body, { status, headers });
		} catch (error) {
			await handle.close().catch(() => undefined);
			throw error;
		}
	}

	async save(
		rootId: string,
		raw: string,
		body: WorkspaceSave,
		by: string,
	): Promise<WorkspaceSaved> {
		const located = await this.#located(rootId, raw);
		const { root } = located;
		if (Buffer.byteLength(body.text) > EDIT_MAX_BYTES)
			throw new WorkspaceRefusal(413, "text-too-large");
		const parent = await this.#parentOf(located, raw);
		this.#guardWrite(located, parent, raw);
		let leaf: Stats;
		try {
			leaf = await lstat(parent.path);
		} catch (error) {
			if (errno(error) === "ENOENT") throw new WorkspaceConflictError("gone");
			return mapFs(error);
		}
		if (leaf.isSymbolicLink()) throw this.#refuse(root.id, raw, 403, "symlink");
		if (!leaf.isFile()) throw this.#refuse(root.id, raw, 403, "special");
		const current = await this.#readCurrent(parent.path, leaf, root.id, raw);
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
			await this.#hooks.beforeReplace?.(tmp, parent.path);
			// The directory is the one that was checked, the file is still a regular file, and nobody
			// changed it while the temporary file was written.
			let again: string;
			try {
				again = await realpath(dirname(tmp));
			} catch {
				throw this.#refuse(root.id, raw, 403, "outside");
			}
			if (again !== parent.dir || !within(located.real, again))
				throw this.#refuse(root.id, raw, 403, "outside");
			let leafNow: Stats;
			try {
				leafNow = await lstat(parent.path);
			} catch (error) {
				if (errno(error) === "ENOENT") throw new WorkspaceConflictError("gone");
				return mapFs(error);
			}
			if (leafNow.isSymbolicLink())
				throw this.#refuse(root.id, raw, 403, "symlink");
			if (!leafNow.isFile()) throw this.#refuse(root.id, raw, 403, "special");
			const latest = await this.#readCurrent(
				parent.path,
				leafNow,
				root.id,
				raw,
			);
			const now = hashOf(latest.bytes);
			if (now !== body.baseHash)
				throw new WorkspaceConflictError("changed", {
					hash: now,
					mtimeMs: latest.mtimeMs,
					size: latest.bytes.byteLength,
				});
			await rename(tmp, parent.path);
		} catch (error) {
			await this.#discard(tmp, created, handle);
			throw error instanceof WorkspaceRefusal ||
				error instanceof WorkspaceConflictError
				? error
				: this.#unwrap(error);
		} finally {
			await handle?.close().catch(() => undefined);
		}
		const info = await stat(parent.path);
		const to = hashOf(payload);
		this.#logger.info(
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

	#unwrap(error: unknown): never {
		return mapFs(error);
	}

	/**
	 * Removes a temporary file. When its directory can no longer be found at the same place (it
	 * was moved away), the file is emptied through its handle instead, so no text stays behind.
	 */
	async #discard(
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

	/** The bytes of a regular file, opened without following a link and compared with its earlier stat. */
	async #readCurrent(
		path: string,
		checked: { dev: number; ino: number },
		rootId: string,
		raw: string,
	): Promise<{ bytes: Uint8Array; mtimeMs: number; mode: number }> {
		const handle = await this.#openRegular(path, checked, rootId, raw);
		try {
			const info = await handle.stat();
			if (info.size > EDIT_MAX_BYTES)
				throw new WorkspaceRefusal(403, "too-large");
			const bytes = await this.#readAll(handle, info.size, EDIT_MAX_BYTES);
			return { bytes, mtimeMs: info.mtimeMs, mode: info.mode & 0o7777 };
		} finally {
			await handle.close();
		}
	}

	async create(
		rootId: string,
		raw: string,
		body: WorkspaceNew,
		by: string,
	): Promise<WorkspaceSaved> {
		const located = await this.#located(rootId, raw);
		const { root } = located;
		const text = body.text ?? "";
		if (Buffer.byteLength(text) > EDIT_MAX_BYTES)
			throw new WorkspaceRefusal(413, "text-too-large");
		const parent = await this.#parentOf(located, raw);
		this.#guardWrite(located, parent, raw);
		try {
			if (body.kind === "dir") await mkdir(parent.path, { mode: 0o755 });
			else await writeFile(parent.path, text, { flag: "wx", mode: 0o644 });
		} catch (error) {
			if (errno(error) === "EEXIST") throw new WorkspaceConflictError("exists");
			return mapFs(error);
		}
		this.#logger.info(
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
	async #moveNew(
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

	async rename(
		rootId: string,
		fromRaw: string,
		toRaw: string,
		by: string,
	): Promise<void> {
		const located = await this.#located(rootId, fromRaw);
		const destination = await this.#located(rootId, toRaw);
		const { root } = located;
		const fromParent = await this.#parentOf(located, fromRaw);
		const toParent = await this.#parentOf(destination, toRaw);
		this.#guardWrite(located, fromParent, fromRaw);
		this.#guardWrite(destination, toParent, toRaw);
		let leaf: Stats;
		try {
			leaf = await lstat(fromParent.path);
		} catch (error) {
			return mapFs(error);
		}
		if (!leaf.isFile() && !leaf.isDirectory() && !leaf.isSymbolicLink())
			throw this.#refuse(root.id, fromRaw, 403, "special");
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
			await this.#moveNew(
				fromParent.path,
				toParent.path,
				leaf.isFile() ? "file" : "other",
			);
		} catch (error) {
			if (errno(error) === "EEXIST") throw new WorkspaceConflictError("exists");
			return mapFs(error);
		}
		this.#logger.info(
			{ by, root: root.id, path: fromRaw, to: toRaw },
			"workspace entry renamed by an owner",
		);
	}

	/** The trash directory of a root, made when there is none; a link or a file in its place is refused. */
	async #trashDir(real: string, create: boolean): Promise<string | undefined> {
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

	async remove(
		rootId: string,
		raw: string,
		by: string,
	): Promise<WorkspaceTrashItem> {
		const located = await this.#located(rootId, raw);
		const { root, real, segments } = located;
		const parent = await this.#parentOf(located, raw);
		this.#guardWrite(located, parent, raw);
		let leaf: Stats;
		try {
			leaf = await lstat(parent.path);
		} catch (error) {
			return mapFs(error);
		}
		if (!leaf.isFile() && !leaf.isDirectory() && !leaf.isSymbolicLink())
			throw this.#refuse(root.id, raw, 403, "special");
		const trash = await this.#trashDir(real, true);
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
			const back = await this.#moveNew(
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
				this.#logger.warn(
					{ by, root: root.id, path: raw, trash: id },
					"workspace entry could not be moved back; it stays in the trash",
				);
			}
			return mapFs(error);
		}
		this.#logger.info(
			{ by, root: root.id, path: raw, trash: id },
			"workspace entry moved to the trash by an owner",
		);
		return item;
	}

	async trash(rootId: string): Promise<WorkspaceTrashView> {
		const located = await this.#locate(rootId, "");
		if (located === "missing") return { items: [] };
		const dir = await this.#trashDir(located.real, false);
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

	#trashId(rootId: string, id: string): string {
		if (!TRASH_ID.test(id)) throw this.#refuse(rootId, id, 400, "bad-path");
		return id;
	}

	async restore(
		rootId: string,
		id: string,
		by: string,
	): Promise<{ path: string }> {
		const root = this.#roots.get(rootId);
		if (!root) throw new WorkspaceRefusal(404, "unknown-root");
		if (!root.writable) throw this.#refuse(rootId, id, 403, "read-only-root");
		this.#trashId(rootId, id);
		const located = await this.#located(rootId, "");
		const dir = await this.#trashDir(located.real, false);
		if (!dir) throw new WorkspaceRefusal(404, "not-found");
		const itemDir = join(dir, id);
		// The folder of an item is one this code made; a link in its place is something an agent planted.
		const folder = await lstat(itemDir).catch(mapFs);
		if (!folder.isDirectory()) throw this.#refuse(rootId, id, 403, "special");
		let recorded: { path?: unknown };
		try {
			recorded = JSON.parse(await readFile(join(itemDir, "meta.json"), "utf8"));
		} catch (error) {
			return mapFs(error);
		}
		// The recorded place is only text in a file an agent could have written: it goes through
		// every check a new path does.
		const raw = typeof recorded.path === "string" ? recorded.path : "";
		const target = await this.#located(rootId, raw);
		const parent = await this.#parentOf(target, raw).catch((error) => {
			if (error instanceof WorkspaceRefusal && error.reason === "not-found")
				throw new WorkspaceConflictError("gone");
			throw error;
		});
		this.#guardWrite(target, parent, raw);
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
			await this.#moveNew(
				itemPath,
				parent.path,
				leaf.isFile() ? "file" : "other",
			);
		} catch (error) {
			if (errno(error) === "EEXIST") throw new WorkspaceConflictError("exists");
			return mapFs(error);
		}
		await rm(itemDir, { recursive: true, force: true });
		this.#logger.info(
			{ by, root: rootId, path: raw, trash: id },
			"workspace entry restored by an owner",
		);
		return { path: raw };
	}

	async purge(rootId: string, id: string, by: string): Promise<void> {
		const root = this.#roots.get(rootId);
		if (!root) throw new WorkspaceRefusal(404, "unknown-root");
		if (!root.writable) throw this.#refuse(rootId, id, 403, "read-only-root");
		this.#trashId(rootId, id);
		const located = await this.#located(rootId, "");
		const dir = await this.#trashDir(located.real, false);
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
		this.#logger.info(
			{ by, root: rootId, trash: id },
			"workspace trash item deleted for good by an owner",
		);
	}
}
