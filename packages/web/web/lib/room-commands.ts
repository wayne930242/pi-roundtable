// The slash commands of a room's message box. Each page that has a box hands the list to its
// composer; a command to come is one more entry here.

import { useEffect, useMemo, useState } from "react";
import type { RoomCommandView } from "../../src/api-types.ts";
import { api } from "./api.ts";
import { translate as t } from "./messages.ts";
import { askRoomConfirm } from "./room-confirm.ts";
import type { SlashCommand } from "./slash-commands.ts";
import { toast } from "./toast.ts";

/**
 * The commands the room offers: `/clear` (and `/new`) run by the page, which is the room menu's
 * Start over with the same question first, and, for a knight's room, the skills the knight carries
 * and the extension commands plugins declared, which the host lists for the owner. Those two are
 * sent as a message. A group's room, or any read-only room, has the page's commands only.
 */
export function useRoomCommands(
	room: string,
	name: string,
	hosted = true,
): SlashCommand[] {
	const [served, setServed] = useState<{
		room: string;
		list: RoomCommandView[];
	}>();
	useEffect(() => {
		if (!hosted) return;
		let current = true;
		// A host that does not answer leaves the page's own commands; the menu is not worth an error.
		api.roomCommands(room).then(
			(view) => current && setServed({ room, list: view.commands }),
			() => undefined,
		);
		return () => {
			current = false;
		};
	}, [room, hosted]);
	const list = served?.room === room ? served.list : undefined;
	return useMemo(
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
			...(list ?? []).map((one) => ({
				name: one.name,
				description: one.description,
			})),
		],
		[room, name, list],
	);
}

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
