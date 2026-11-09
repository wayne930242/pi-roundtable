import { useEffect, useMemo, useState } from "react";
import { useSelector } from "../lib/app-store.ts";
import { useConfig } from "../lib/config.ts";
import { plural, translate as t } from "../lib/messages.ts";
import { activityAt } from "../lib/rooms.ts";
import { sections, type ThreadKeys } from "../lib/sections.ts";
import { ThreadList } from "../pages/rooms.tsx";
import { Icon } from "./icons.tsx";
import { Sheet } from "./sheet.tsx";

/**
 * On the chat home a room's dispatch threads and temp knights are not rows of the list, so they are
 * reached here: a control in the room's header with how many there are, which opens them as the
 * cards the room list used to nest under it. Nothing when the room has none, or the host keeps the
 * room list, where they still hang under their room.
 */
export function RoomThreadsButton(props: { room: string }) {
	const chats = useConfig().app?.home === "chats";
	const shape = useSelector((state) =>
		JSON.stringify(
			sections(state, (key) => activityAt(state, key)).threads[props.room] ?? {
				open: [],
				closed: [],
			},
		),
	);
	const threads = useMemo(() => JSON.parse(shape) as ThreadKeys, [shape]);
	const [open, setOpen] = useState(false);
	// The control's styles come with the chat home's, which a room opened by its address has not loaded yet.
	useEffect(() => {
		if (chats)
			import("../lib/chats-home-style.ts").then((m) =>
				m.installChatsHomeStyle(),
			);
	}, [chats]);
	const count = threads.open.length + threads.closed.length;
	if (!chats || count === 0) return null;
	const label = plural(count, "{count} thread", "{count} threads");
	return (
		<>
			<button
				type="button"
				className="icon-button room-threads"
				aria-label={label}
				aria-haspopup="dialog"
				onClick={() => setOpen(true)}
			>
				<Icon name="list" />
				<span className="room-threads-count" aria-hidden="true">
					{count}
				</span>
			</button>
			<Sheet
				open={open}
				title={t("Dispatch threads")}
				onClose={() => setOpen(false)}
			>
				<ThreadList
					open={threads.open}
					closed={threads.closed}
					active={undefined}
					parent={props.room}
				/>
			</Sheet>
		</>
	);
}
