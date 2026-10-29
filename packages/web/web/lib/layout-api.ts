import type { LayoutView } from "../../src/api-types.ts";
import { request } from "./api.ts";

/** The owner-only routes of the shared room layout; loads with the first edit. */
export const layoutApi = {
	/** Makes a folder, last in the list; the answer is the whole layout. */
	createFolder: (name: string) =>
		request<LayoutView>("folders", {
			method: "POST",
			body: JSON.stringify({ name }),
		}),
	/** Renames a folder and/or places it before another (`null` = last). */
	changeFolder: (
		id: string,
		change: { name?: string; before?: string | null },
	) =>
		request<LayoutView>(`folders/${encodeURIComponent(id)}`, {
			method: "PATCH",
			body: JSON.stringify(change),
		}),
	deleteFolder: (id: string) =>
		request<LayoutView>(`folders/${encodeURIComponent(id)}`, {
			method: "DELETE",
		}),
	/** Mutes or unmutes the push of every room in a folder; the answer names the rooms it reached. */
	muteFolder: (id: string, muted: boolean) =>
		request<{ muted: boolean; rooms: string[] }>(
			`folders/${encodeURIComponent(id)}/mute`,
			{ method: "PUT", body: JSON.stringify({ muted }) },
		),
	/** Puts a room in a folder before another room of it (`null` = last), or in none with `folder` null. */
	placeRoom: (room: string, folder: string | null, before: string | null) =>
		request<LayoutView>(`rooms/${encodeURIComponent(room)}/folder`, {
			method: "PUT",
			body: JSON.stringify({ folder, before }),
		}),
	/** Pins a room before another pinned room (`null` = last), or unpins it. */
	pinRoom: (room: string, pinned: boolean, before: string | null) =>
		request<LayoutView>(`rooms/${encodeURIComponent(room)}/pin`, {
			method: "PUT",
			body: JSON.stringify({ pinned, before }),
		}),
};
