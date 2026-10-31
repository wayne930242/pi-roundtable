// The slash commands of a room's message box. Each page that has a box hands the list to its
// composer; a command to come is one more entry here.

import { useMemo } from "react";
import { translate as t } from "./messages.ts";
import { askRoomConfirm } from "./room-confirm.ts";
import type { SlashCommand } from "./slash-commands.ts";
import { toast } from "./toast.ts";

/**
 * `/clear` (and `/new`) in an agent's or group's room: the room menu's Start over, with the same
 * question first. A thread or another read-only room has no box, so nothing there can ask.
 */
export const useRoomCommands = (room: string, name: string): SlashCommand[] =>
	useMemo(
		() => [
			{
				name: "clear",
				aliases: ["new"],
				description: t(
					"Start over: archive this conversation and begin a new one",
				),
				run: (context) =>
					askRoomConfirm({
						kind: "start-over",
						room,
						name,
						restoreFocus: context.focus,
					}),
			},
		],
		[room, name],
	);

/** A host's room keeps its own conversation: `/clear` there says so, and is not sent as a message. */
export const hostRoomCommands: readonly SlashCommand[] = [
	{
		name: "clear",
		aliases: ["new"],
		description: "",
		hidden: true,
		run: () =>
			toast(
				t(
					"This room cannot be started over from here; the host keeps its conversation.",
				),
				"danger",
			),
	},
];
