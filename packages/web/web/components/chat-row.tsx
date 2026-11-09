import { memo } from "react";
import { useAccentStyle } from "../lib/characters.ts";
import { useFigureMotion } from "../lib/figure-motion.ts";
import { ago } from "../lib/format.ts";
import { useMenuPress } from "../lib/menu-press.ts";
import { roomMenuOf } from "../lib/menus.ts";
import { plural, translate as t } from "../lib/messages.ts";
import { hrefFor } from "../lib/router.ts";
import { type RowData, Typing } from "../pages/rooms.tsx";
import { Icon } from "./icons.tsx";
import { ReadReveal } from "./read-swipe.tsx";
import { RoomPicture } from "./room-picture.tsx";

/**
 * A room in the one list of the chat home: its figure, name, time, one line of its last message and,
 * at the end of that line, what waits there: unread messages, cards, and how many dispatch threads
 * run. Dispatch threads and temp knights are reached inside their room, so a row only counts them.
 */
export const ChatRow = memo(function ChatRow(
	props: Omit<RowData, "key"> & {
		active: boolean;
		now: number;
		timeZone: string;
		/** The room's open dispatch threads. */
		threads: number;
		/** Messages of the room the person has not read. */
		unread: number;
		/** The room's folder, tagged on the row where the list mixes folders. */
		folder?: string | undefined;
	},
) {
	const { view } = props;
	const press = useMenuPress(() => roomMenuOf(view.key));
	const accent = useAccentStyle(view.character);
	const { unread } = props;
	const { style: phase, ...motion } = useFigureMotion(
		view.key,
		props.typing,
		unread,
	);
	return (
		<li>
			<ReadReveal />
			<a
				className="room-row chat-row"
				{...press}
				href={hrefFor("room", view.key)}
				data-room={view.key}
				aria-current={props.active ? "page" : undefined}
				{...motion}
				style={{ ...accent, ...phase }}
			>
				{/* A group's stacked figures are 1.45 wide, so they are drawn smaller to keep the names in one column. */}
				<RoomPicture view={view} size={view.kind === "group" ? 36 : 52} bare />
				<span className="room-row-main">
					<span className="room-row-top">
						<strong>{view.displayName}</strong>
						{view.muted ? (
							<Icon
								name="bell-off"
								size={14}
								className="muted-mark"
								role="img"
								aria-hidden={false}
								aria-label={t("Notifications are off")}
							/>
						) : null}
						{props.folder !== undefined ? (
							<span className="folder-tag">{props.folder}</span>
						) : null}
						{view.kind === "group" ? (
							<span className="badge">{t("Group")}</span>
						) : null}
						<span className="room-row-time">
							{props.at ? ago(props.at, props.now, props.timeZone) : ""}
						</span>
					</span>
					<span className="room-row-preview">
						{props.typing ? <Typing /> : null}
						<span className="chat-preview">
							{props.preview || t("No messages yet")}
						</span>
						<span className="chat-pills">
							{props.threads > 0 ? (
								<span className="chat-pill" data-kind="threads">
									{plural(props.threads, "{count} thread", "{count} threads")}
								</span>
							) : null}
							{props.waiting > 0 ? (
								<span className="chat-pill" data-kind="waiting">
									{plural(
										props.waiting,
										"{count} card waiting",
										"{count} cards waiting",
									)}
								</span>
							) : null}
							{unread > 0 ? (
								<span
									className="chat-pill"
									data-kind="unread"
									role="img"
									aria-label={plural(
										unread,
										"{count} unread message",
										"{count} unread messages",
									)}
								>
									{unread > 99 ? "99+" : unread}
								</span>
							) : null}
						</span>
					</span>
				</span>
			</a>
		</li>
	);
});
