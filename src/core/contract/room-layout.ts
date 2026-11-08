import { type ServiceKey, serviceKey } from "./services.ts";

/** The room list of an app as agent and group names: its groups in order, and its pinned rooms. */
export interface RoomGroupsView {
	groups: { name: string; rooms: string[] }[];
	pins: string[];
}

/**
 * The groups of an app's room list, read and changed by agent and group names. A change is one
 * step that no other edit overlaps; a wrong name or group refuses it whole and nothing moves.
 */
export interface RoomLayoutService {
	/** The groups with the active rooms in each, in order, and the pinned rooms. */
	view(): Promise<RoomGroupsView>;
	/** Puts the room into a group, last; `null` takes it out of every group. A missing group is made. */
	place(name: string, group: string | null): Promise<void>;
	/**
	 * The listed groups first in list order, then the others as they were; in each listed group the
	 * listed rooms first in order, then its other rooms. Missing groups are made, and rooms not
	 * listed keep their place.
	 */
	arrange(
		entries: readonly { group: string; names: readonly string[] }[],
	): Promise<void>;
}

/** The room groups of the web app; pi-roundtable-web provides it while its rooms pane is served. */
export const ROOM_LAYOUT: ServiceKey<RoomLayoutService> =
	serviceKey<RoomLayoutService>("roundtable.room-layout", {
		absent:
			"the room groups belong to an app's room list; register pi-roundtable-web with its rooms pane.",
	});
