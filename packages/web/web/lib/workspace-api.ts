import type {
	WorkspaceConflict,
	WorkspaceFileView,
	WorkspaceListView,
	WorkspaceRootsView,
	WorkspaceSaved,
	WorkspaceTrashItem,
	WorkspaceTrashView,
} from "../../src/api-types.ts";
import { ApiFailure, request } from "./api.ts";

const base = (root: string) => `workspace/${encodeURIComponent(root)}`;
const at = (path: string) => `path=${encodeURIComponent(path)}`;
const json = (body: unknown): RequestInit => ({
	body: JSON.stringify(body),
});

/** A save the file's changes got in the way of: the file as it is now, or that it is gone or already there. */
export function conflictOf(failure: unknown): WorkspaceConflict | undefined {
	if (!(failure instanceof ApiFailure) || failure.status !== 409)
		return undefined;
	const body = failure.body as Partial<WorkspaceConflict> | undefined;
	return body?.conflict === "changed" ||
		body?.conflict === "gone" ||
		body?.conflict === "exists"
		? (body as WorkspaceConflict)
		: undefined;
}

/** The workspace files pane's API; paths are relative to a root and use `/`. */
export const workspaceApi = {
	roots: () => request<WorkspaceRootsView>("workspace"),
	list: (root: string, path: string) =>
		request<WorkspaceListView>(`${base(root)}/list?${at(path)}`),
	file: (root: string, path: string) =>
		request<WorkspaceFileView>(`${base(root)}/file?${at(path)}`),
	save: (root: string, path: string, text: string, baseHash: string) =>
		request<WorkspaceSaved>(`${base(root)}/file?${at(path)}`, {
			method: "PUT",
			...json({ text, baseHash }),
		}),
	create: (root: string, path: string, kind: "file" | "dir", text?: string) =>
		request<WorkspaceSaved>(`${base(root)}/new?${at(path)}`, {
			method: "POST",
			...json({ kind, ...(text === undefined ? {} : { text }) }),
		}),
	rename: (root: string, from: string, to: string) =>
		request<{ ok: true }>(`${base(root)}/rename`, {
			method: "POST",
			...json({ from, to }),
		}),
	remove: (root: string, path: string) =>
		request<WorkspaceTrashItem>(`${base(root)}/entry?${at(path)}`, {
			method: "DELETE",
		}),
	trash: (root: string) => request<WorkspaceTrashView>(`${base(root)}/trash`),
	restore: (root: string, id: string) =>
		request<{ path: string }>(
			`${base(root)}/trash/${encodeURIComponent(id)}/restore`,
			{ method: "POST" },
		),
	purge: (root: string, id: string) =>
		request<{ ok: true }>(`${base(root)}/trash/${encodeURIComponent(id)}`, {
			method: "DELETE",
		}),
};

/** Where the browser fetches a file's bytes: a picture's `src`, or a download link. */
export const rawHref = (root: string, path: string, download = false): string =>
	`api/${base(root)}/raw?${at(path)}${download ? "&download=1" : ""}`;
