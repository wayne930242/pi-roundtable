import type {
	WorkspaceFileView,
	WorkspaceListView,
	WorkspaceNew,
	WorkspaceRootView,
	WorkspaceSave,
	WorkspaceSaved,
	WorkspaceTrashItem,
	WorkspaceTrashView,
} from "../api-types.ts";
import { WorkspaceGuard } from "./workspace-guard.ts";
import { listDirectory } from "./workspace-list.ts";
import type { WorkspaceFilesOptions } from "./workspace-model.ts";
import { createEntry, renameEntry } from "./workspace-move.ts";
import { type RawConditions, rawFile } from "./workspace-raw.ts";
import { saveFile } from "./workspace-save.ts";
import {
	listTrash,
	purgeEntry,
	removeEntry,
	restoreEntry,
} from "./workspace-trash.ts";
import { readFileView } from "./workspace-view.ts";

export { checkRoots } from "./workspace-check.ts";
export { languageOf } from "./workspace-language.ts";
export {
	DOWNLOAD_MAX_BYTES,
	EDIT_MAX_BYTES,
	LIST_MAX,
	TRASH_DIR,
	VIEW_MAX_BYTES,
	WorkspaceConflictError,
	type WorkspaceFilesOptions,
	type WorkspaceReason,
	WorkspaceRefusal,
	type WorkspaceRoot,
} from "./workspace-model.ts";
export type { RawConditions } from "./workspace-raw.ts";

/**
 * The owner's view of the files in some directories, with the rules that keep it inside them.
 * Every request names a root by id and a path relative to it; the path is checked as text first,
 * then each directory it passes through is resolved and must be inside the real root, and a file
 * is opened without following a link, its handle compared with what was checked. A write goes to
 * a temporary file in the same directory and replaces the original by rename.
 */
export class WorkspaceFiles {
	readonly #guard: WorkspaceGuard;
	readonly #hooks: NonNullable<WorkspaceFilesOptions["hooks"]>;

	constructor(options: WorkspaceFilesOptions) {
		this.#guard = new WorkspaceGuard(options);
		this.#hooks = options.hooks ?? {};
	}

	/** Runs `run` so that what it refuses is logged with who asked. */
	speaking<T>(by: string, run: () => Promise<T>): Promise<T> {
		return this.#guard.speaking(by, run);
	}

	roots(): WorkspaceRootView[] {
		return this.#guard.rootViews();
	}

	list(rootId: string, raw: string): Promise<WorkspaceListView> {
		return listDirectory(this.#guard, rootId, raw);
	}

	read(rootId: string, raw: string): Promise<WorkspaceFileView> {
		return readFileView(this.#guard, rootId, raw);
	}

	raw(
		rootId: string,
		raw: string,
		download: boolean,
		conditions: RawConditions = {},
	): Promise<Response> {
		return rawFile(this.#guard, rootId, raw, download, conditions);
	}

	save(
		rootId: string,
		raw: string,
		body: WorkspaceSave,
		by: string,
	): Promise<WorkspaceSaved> {
		return saveFile(this.#guard, this.#hooks, rootId, raw, body, by);
	}

	create(
		rootId: string,
		raw: string,
		body: WorkspaceNew,
		by: string,
	): Promise<WorkspaceSaved> {
		return createEntry(this.#guard, rootId, raw, body, by);
	}

	rename(
		rootId: string,
		fromRaw: string,
		toRaw: string,
		by: string,
	): Promise<void> {
		return renameEntry(this.#guard, rootId, fromRaw, toRaw, by);
	}

	remove(rootId: string, raw: string, by: string): Promise<WorkspaceTrashItem> {
		return removeEntry(this.#guard, rootId, raw, by);
	}

	trash(rootId: string): Promise<WorkspaceTrashView> {
		return listTrash(this.#guard, rootId);
	}

	restore(rootId: string, id: string, by: string): Promise<{ path: string }> {
		return restoreEntry(this.#guard, rootId, id, by);
	}

	purge(rootId: string, id: string, by: string): Promise<void> {
		return purgeEntry(this.#guard, rootId, id, by);
	}
}
