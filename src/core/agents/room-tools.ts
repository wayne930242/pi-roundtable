import { Type } from "typebox";
import { AgentError } from "../domain/errors.ts";
import {
	requiredString,
	stringList,
	type TextToolDef,
} from "../runtime/text-tools.ts";
import { NO_ROOM_GROUPS, type RoomOps } from "./team-rooms.ts";

/** The `group` of agent_create and group_create: the room's group in the app. */
export const ROOM_GROUP = Type.String({
	minLength: 1,
	maxLength: 40,
	description:
		"The group its room goes into in the web app's room list, made when missing; agent_list shows the groups there. Leave it out to keep the room ungrouped.",
});

/**
 * Makes an agent or group, then places its room in the app group when one is given. A group the
 * host cannot place in refuses before anything is made.
 */
export async function placedAfter(
	rooms: RoomOps | undefined,
	name: string,
	group: string | undefined,
	make: () => Promise<string>,
): Promise<string> {
	if (group === undefined) return make();
	if (!rooms) throw new AgentError(NO_ROOM_GROUPS);
	rooms.check(group);
	const made = await make();
	try {
		return `${made} ${await rooms.place(name, group)}`;
	} catch (error) {
		const why = error instanceof Error ? error.message : String(error);
		return `${made} Its room stays ungrouped: ${why}`;
	}
}

/** The tool that sorts rooms into the app's groups. */
export function roomToolDefs(
	rooms: RoomOps | undefined,
	owner: string,
): TextToolDef<"room_arrange">[] {
	return [
		{
			name: "room_arrange",
			label: "Arrange app rooms",
			description: `Sort agent and group rooms into the web app's room groups and order them, when ${owner} asks. Missing groups are made. The listed groups come first in the room list in list order, then every other group as it was; in each listed group the listed rooms come first in order, then its other rooms as they were. Rooms you leave out keep their place, Home stays on top, and a temp knight's room stays under its knight's. Any wrong entry refuses the whole call and nothing moves. Read the current groups with agent_list first.`,
			parameters: Type.Object({
				groups: Type.Array(
					Type.Object({
						group: Type.String({
							minLength: 1,
							maxLength: 40,
							description:
								"The group's name, 1 to 40 characters in any language.",
						}),
						names: Type.Array(Type.String(), {
							minItems: 1,
							description:
								"Agent or group names (from agent_list), in the order their rooms should appear.",
						}),
					}),
					{ minItems: 1, description: "Groups in room-list order." },
				),
			}),
			run: (i) => {
				if (!rooms) throw new AgentError(NO_ROOM_GROUPS);
				const entries = Array.isArray(i.groups) ? i.groups : [];
				return rooms.arrange(
					entries.map((entry: Record<string, unknown>) => ({
						group: requiredString(entry, "group"),
						names: stringList(entry, "names") ?? [],
					})),
				);
			},
		},
	];
}
