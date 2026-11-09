import { AsyncLocalStorage } from "node:async_hooks";
import { realpathSync, type Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { lstat, open, realpath, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { Logger } from "pi-roundtable";
import { within } from "pi-roundtable/kit";
import type { WorkspaceRootView } from "../api-types.ts";
import { realish } from "./workspace-check.ts";
import {
	EDIT_MAX_BYTES,
	errno,
	isGitDir,
	isTrashDir,
	mapFs,
	OPEN_READ,
	parsePath,
	type WorkspaceFilesOptions,
	type WorkspaceReason,
	WorkspaceRefusal,
	type WorkspaceRoot,
} from "./workspace-model.ts";

export interface Located {
	root: WorkspaceRoot;
	/** The real directory of the root. */
	real: string;
	segments: string[];
}

/** A parent directory, resolved and checked to lie inside the root. */
export interface Parent {
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
 * The rules that keep a request inside the roots: which root and real directory a path names,
 * what its parent is, what may be written, and how a file is opened without following a link.
 * Every refusal is logged with who asked.
 */
export class WorkspaceGuard {
	readonly #roots: Map<string, WorkspaceRoot>;
	readonly logger: Logger;
	/** Where each root really was when it was first seen; a root that resolves elsewhere later is refused. */
	readonly #pinned = new Map<string, string>();
	readonly #guarded: readonly string[];
	readonly #speaker = new AsyncLocalStorage<string>();

	constructor(
		options: Pick<WorkspaceFilesOptions, "roots" | "logger" | "protectedDirs">,
	) {
		this.#roots = new Map(options.roots.map((root) => [root.id, root]));
		this.#guarded = (options.protectedDirs ?? []).map(realish);
		for (const root of options.roots) {
			try {
				this.#pinned.set(root.id, realpathSync(root.dir));
			} catch {
				// A root that is not there yet is pinned where it first appears.
			}
		}
		this.logger = options.logger;
	}

	/** Runs `run` so that what it refuses is logged with who asked. */
	speaking<T>(by: string, run: () => Promise<T>): Promise<T> {
		return this.#speaker.run(by, run);
	}

	root(rootId: string): WorkspaceRoot | undefined {
		return this.#roots.get(rootId);
	}

	rootViews(): WorkspaceRootView[] {
		return [...this.#roots.values()].map(({ id, label, writable }) => ({
			id,
			label,
			writable,
		}));
	}

	refuse(
		rootId: string,
		path: string,
		status: number,
		reason: WorkspaceReason,
	): WorkspaceRefusal {
		this.logger.warn(
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
	async locate(rootId: string, raw: string): Promise<Located | "missing"> {
		const root = this.#roots.get(rootId);
		if (!root) throw new WorkspaceRefusal(404, "unknown-root");
		let segments: string[];
		try {
			segments = parsePath(raw);
		} catch (error) {
			if (error instanceof WorkspaceRefusal)
				throw this.refuse(rootId, raw, error.status, error.reason);
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
				throw this.refuse(root.id, raw, 403, "outside");
			this.#pinned.set(root.id, real);
		} else if (pinned !== real) throw this.refuse(root.id, raw, 403, "outside");
		return { root, real, segments };
	}

	async located(rootId: string, raw: string): Promise<Located> {
		const located = await this.locate(rootId, raw);
		if (located === "missing") throw new WorkspaceRefusal(404, "not-found");
		return located;
	}

	/** Resolves the directory a leaf is in and refuses one that leaves the root. */
	async parentOf(located: Located, raw: string): Promise<Parent> {
		const { real, root, segments } = located;
		const name = segments.at(-1);
		if (name === undefined) throw new WorkspaceRefusal(400, "is-root");
		let dir: string;
		try {
			dir = await realpath(join(real, ...segments.slice(0, -1)));
		} catch (error) {
			return mapFs(error);
		}
		if (!within(real, dir)) throw this.refuse(root.id, raw, 403, "outside");
		return {
			dir,
			name,
			path: join(dir, name),
			relative: relative(real, dir).split(sep).filter(Boolean),
		};
	}

	/** A write is refused in a read-only root, in `.git` and in the trash, by name and by where the parent really is. */
	guardWrite(located: Located, parent: Parent | undefined, raw: string): void {
		const { root, segments } = located;
		if (!root.writable) throw this.refuse(root.id, raw, 403, "read-only-root");
		const names = [...segments, ...(parent?.relative ?? [])];
		if (names.some(isGitDir)) throw this.refuse(root.id, raw, 403, "git-dir");
		if (isTrashDir(segments[0]) || isTrashDir(parent?.relative[0]))
			throw this.refuse(root.id, raw, 403, "trash-dir");
	}

	/** Opens a regular file without following a link; the handle must be the file that was checked. */
	async openRegular(
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
				throw this.refuse(rootId, raw, 403, "symlink");
			return mapFs(error);
		}
		const info = await handle.stat();
		if (
			!info.isFile() ||
			info.dev !== checked.dev ||
			info.ino !== checked.ino
		) {
			await handle.close();
			throw this.refuse(rootId, raw, 403, "special");
		}
		return handle;
	}

	/**
	 * Where a file read really is, and its stat: a link inside the root is followed to its target,
	 * a link to the outside is refused, anything that is not a file or folder is refused.
	 */
	async target(
		located: Located,
		raw: string,
	): Promise<{ path: string; info: Stats; viaLink: boolean }> {
		const { root, real, segments } = located;
		if (segments.length === 0)
			return { path: real, info: await stat(real), viaLink: false };
		const parent = await this.parentOf(located, raw);
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
					throw this.refuse(root.id, raw, 403, "outside");
				return mapFs(error);
			}
			if (!within(real, path)) throw this.refuse(root.id, raw, 403, "outside");
		}
		let info: Stats;
		try {
			info = await stat(path);
		} catch (error) {
			return mapFs(error);
		}
		if (!info.isFile() && !info.isDirectory())
			throw this.refuse(root.id, raw, 403, "special");
		return { path, info, viaLink };
	}

	/** Reads a regular file whole, up to `limit` bytes; one that has grown past it is a refusal. */
	async readAll(
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

	/** The bytes of a regular file, opened without following a link and compared with its earlier stat. */
	async readCurrent(
		path: string,
		checked: { dev: number; ino: number },
		rootId: string,
		raw: string,
	): Promise<{ bytes: Uint8Array; mtimeMs: number; mode: number }> {
		const handle = await this.openRegular(path, checked, rootId, raw);
		try {
			const info = await handle.stat();
			if (info.size > EDIT_MAX_BYTES)
				throw new WorkspaceRefusal(403, "too-large");
			const bytes = await this.readAll(handle, info.size, EDIT_MAX_BYTES);
			return { bytes, mtimeMs: info.mtimeMs, mode: info.mode & 0o7777 };
		} finally {
			await handle.close();
		}
	}
}
