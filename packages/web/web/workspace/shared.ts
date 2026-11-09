import { createContext, useContext, useEffect, useState } from "react";
import type {
	WorkspaceEntry,
	WorkspaceListView,
	WorkspaceRootView,
} from "../../src/api-types.ts";
import { messageOf } from "../lib/api.ts";
import { translate as t } from "../lib/messages.ts";
import { hrefFor } from "../lib/router.ts";
import { workspaceApi } from "../lib/workspace-api.ts";
import { join, type Place, placeKey } from "../lib/workspace-place.ts";
/** A root's name as the pane shows it: the agents' two places are worded here, a host's own as given. */
export function rootLabel(root: WorkspaceRootView): string {
	if (root.id === "agents") return t("Knights' workspace");
	if (root.id === "scratch") return t("Scratch");
	return root.label;
}

/** Folders that are listed but kept shut and dimmed: they are large and rarely what is wanted. */
export const QUIET = new Set([".git", "node_modules"]);

export const OPEN_KEY = (root: string) => `roundtable.workspace.open.${root}`;
export const TREE_KEY = "roundtable.workspace.tree";
export const WRAP_KEY = "roundtable.workspace.wrap";

export function stored<T>(key: string, fallback: T): T {
	try {
		const raw = localStorage.getItem(key);
		return raw === null ? fallback : (JSON.parse(raw) as T);
	} catch {
		return fallback;
	}
}
export function keep(key: string, value: unknown): void {
	try {
		localStorage.setItem(key, JSON.stringify(value));
	} catch {
		// Private browsing: the choice lasts for this page only.
	}
}

export interface Shared {
	/** Changes when something was created, renamed, deleted or restored: lists fetch again. */
	rev: number;
	bump(): void;
}
export const SharedContext = createContext<Shared>({
	rev: 0,
	bump: () => undefined,
});

/**
 * What was listed last for each folder. A folder that was shown before shows at once while it is
 * fetched again, so a visit, or a branch of the tree opened a second time, never starts from nothing.
 */
const LISTED = new Map<string, WorkspaceListView>();
const LISTED_MAX = 200;
export function remember(key: string, data: WorkspaceListView): void {
	LISTED.delete(key);
	LISTED.set(key, data);
	const oldest = LISTED.keys().next().value;
	if (LISTED.size > LISTED_MAX && oldest !== undefined) LISTED.delete(oldest);
}
/** Forgets the folders listed so far (a test starts clean; the page never needs it). */
export const forgetListings = (): void => LISTED.clear();

export interface Listing {
	data?: WorkspaceListView;
	error?: string;
	/** The folder `data` lists: a new place keeps showing the last one until its own arrives. */
	at?: { root: string; path: string };
	/** `data` is of the folder shown before, and the one asked for is on its way. */
	pending?: true;
}

/** A directory's entries, fetched when it is shown, when something changed, and when the page regains focus. */
export function useListing(
	root: string,
	path: string,
	enabled = true,
): Listing {
	const { rev } = useContext(SharedContext);
	const [focus, setFocus] = useState(0);
	const [state, setState] = useState<{
		key: string;
		root: string;
		path: string;
		data?: WorkspaceListView;
		error?: string;
	}>({ key: "", root, path });
	const key = `${root}:${path}`;
	useEffect(() => {
		const onFocus = () => setFocus((value) => value + 1);
		window.addEventListener("focus", onFocus);
		return () => window.removeEventListener("focus", onFocus);
	}, []);
	// biome-ignore lint/correctness/useExhaustiveDependencies: the counters say when to fetch
	useEffect(() => {
		if (!enabled) return;
		let current = true;
		workspaceApi.list(root, path).then(
			(data) => {
				remember(key, data);
				if (current) setState({ key, root, path, data });
			},
			(failure) =>
				current && setState({ key, root, path, error: messageOf(failure) }),
		);
		return () => {
			current = false;
		};
	}, [root, path, enabled, rev, focus]);
	if (state.key === key)
		return { data: state.data, error: state.error, at: state };
	const known = LISTED.get(key);
	if (known) return { data: known, at: { root, path } };
	// Not listed before: the last folder stays up, dimmed, rather than a blank that collapses the pane.
	if (state.data) return { data: state.data, at: state, pending: true };
	return {};
}

export const hrefOf = (place: Place) => hrefFor("workspace", placeKey(place));

/** What an entry opens: a file, a folder, or nothing (a link out of the root, a pipe). */
export function entryTarget(
	root: string,
	dir: string,
	entry: WorkspaceEntry,
): Place | undefined {
	const path = join(dir, entry.name);
	if (entry.kind === "dir") return { root, path, dir: true };
	if (entry.kind === "file") return { root, path, dir: false };
	if (entry.kind === "symlink" && entry.inside)
		return { root, path, dir: entry.target === "dir" };
	return undefined;
}
