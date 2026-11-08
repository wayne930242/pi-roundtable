import {
	type AgentDirectory,
	agentRoomKey,
	type ChannelKey,
	groupRoomKey,
	isHelper,
	type RoomGroupsView,
	type RoomLayoutService,
	roomOf,
} from "pi-roundtable";
import type { LayoutView } from "../api-types.ts";
import {
	createFolder,
	folderNameOf,
	LayoutError,
	placeRoom,
	shown,
} from "../layout-order.ts";
import type { LayoutStore } from "./layout.ts";
import type { Rooms } from "./rooms.ts";

export interface RoomLayoutServiceOptions {
	layout: LayoutStore;
	/** The key prefix of the rooms, such as `app`. */
	surface: string;
	directory: Pick<AgentDirectory, "agent" | "group">;
	rooms: Pick<Rooms, "placeable" | "homeKey">;
	/** Called after a change, as the layout routes call it, so the open pages refetch the room list. */
	changed(): void;
}

/** A refusal of the layout edits as the agent reads it; the app's folders are its groups. */
function wordsOf(error: LayoutError): string {
	switch (error.code) {
		case "bad-name":
			return "Give the group a name of 1 to 40 characters.";
		case "no-folder":
			return "There is no such group.";
		case "duplicate":
			return "A group of that name exists.";
		case "full":
			return "There are 50 groups already.";
	}
}

const same = (a: string, b: string): boolean =>
	a.toLocaleLowerCase() === b.toLocaleLowerCase();

/** The folder of that name, made last when there is none; with the layout that has it. */
function folderNamed(
	layout: LayoutView,
	raw: string,
): { layout: LayoutView; id: string } {
	const name = folderNameOf(raw);
	const found = layout.folders.find((folder) => same(folder.name, name));
	if (found) return { layout, id: found.id };
	const id = `folder.${crypto.randomUUID()}`;
	return { layout: createFolder(layout, id, name), id };
}

/**
 * `ROOM_LAYOUT` over the app's stored layout: the agent tools place rooms by agent and group
 * names, and each change runs through `LayoutStore.change`, under its lock, then tells the open
 * pages as the layout routes do.
 */
export function roomLayoutService(
	options: RoomLayoutServiceOptions,
): RoomLayoutService {
	const { layout, surface, directory, rooms } = options;

	/** The key of a room that may be placed; throws why another may not. */
	const keyOf = (name: string): string => {
		const agent = directory.agent(name);
		const group = agent ? undefined : directory.group(name);
		if (agent && isHelper(agent))
			throw new Error(
				`"${name}" is a temp knight; its room stays under its knight's.`,
			);
		const key = agent
			? agentRoomKey(surface, name)
			: group
				? groupRoomKey(surface, name)
				: undefined;
		if (key !== undefined && key === rooms.homeKey())
			throw new Error("Home stays at the top.");
		if (key === undefined || !rooms.placeable().has(key))
			throw new Error(`There is no active agent or group "${name}".`);
		return key;
	};

	const change = async (
		edit: (stored: LayoutView) => LayoutView,
	): Promise<void> => {
		try {
			await layout.change(edit);
		} catch (error) {
			throw error instanceof LayoutError ? new Error(wordsOf(error)) : error;
		}
		options.changed();
	};

	return {
		async view(): Promise<RoomGroupsView> {
			const placeable = rooms.placeable();
			const visible = shown(await layout.view(), (key) => placeable.has(key));
			const nameOf = (key: string) =>
				roomOf(key as ChannelKey, [surface])?.name ?? key;
			return {
				groups: visible.folders.map((folder) => ({
					name: folder.name,
					rooms: folder.rooms.map(nameOf),
				})),
				pins: visible.pins.map(nameOf),
			};
		},

		async place(name, group) {
			const key = keyOf(name);
			await change((stored) => {
				if (group === null) return placeRoom(stored, key, null, null);
				const named = folderNamed(stored, group);
				return placeRoom(named.layout, key, named.id, null);
			});
		},

		async arrange(entries) {
			if (entries.length === 0) throw new Error("List at least one group.");
			const listed = entries.map((entry) => ({
				group: entry.group,
				keys: entry.names.map(keyOf),
			}));
			const moved = new Set(listed.flatMap((entry) => entry.keys));
			if (moved.size !== listed.reduce((n, e) => n + e.keys.length, 0))
				throw new Error("A room is listed twice.");
			await change((stored) => {
				let next = stored;
				const ids = listed.map((entry) => {
					const named = folderNamed(next, entry.group);
					next = named.layout;
					return named.id;
				});
				if (new Set(ids).size !== ids.length)
					throw new Error("A group is listed twice.");
				const stay = (keys: readonly string[]) =>
					keys.filter((key) => !moved.has(key));
				const ahead = ids.map((id, at) => {
					const folder = next.folders.find((one) => one.id === id);
					if (!folder) throw new LayoutError("no-folder");
					return {
						...folder,
						rooms: [...(listed[at]?.keys ?? []), ...stay(folder.rooms)],
					};
				});
				const rest = next.folders
					.filter((folder) => !ids.includes(folder.id))
					.map((folder) => ({ ...folder, rooms: stay(folder.rooms) }));
				return { pins: stay(next.pins), folders: [...ahead, ...rest] };
			});
		},
	};
}
