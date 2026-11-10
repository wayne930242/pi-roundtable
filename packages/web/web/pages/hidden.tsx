import { memo, useMemo } from "react";
import { ArchiveList } from "../components/archive-list.tsx";
import { Icon } from "../components/icons.tsx";
import { RoomPicture } from "../components/room-picture.tsx";
import { openMenu } from "../lib/action-menu.ts";
import { useSelector } from "../lib/app-store.ts";
import { useAccentStyle } from "../lib/characters.ts";
import { installChatsHomeStyle } from "../lib/chats-home-style.ts";
import { useConfig } from "../lib/config.ts";
import { ago } from "../lib/format.ts";
import { hideRoom } from "../lib/layout-actions.ts";
import { useLive } from "../lib/live.ts";
import { roomMenuOf } from "../lib/menus.ts";
import { plural, translate as t } from "../lib/messages.ts";
import { activityAt } from "../lib/rooms.ts";
import { hrefFor } from "../lib/router.ts";
import { type Sections, sections } from "../lib/sections.ts";
import { useUnreadMap } from "../lib/unread-map.ts";
import { type RowData, ThreadList, useRowData } from "./rooms.tsx";

/** One hidden room: it still answers, and shows when it last spoke; Unhide returns it to its place. */
const HiddenRoom = memo(function HiddenRoom(
	props: Omit<RowData, "key"> & {
		now: number;
		timeZone: string;
		unread: number;
	},
) {
	const { view } = props;
	const accent = useAccentStyle(view.character);
	const { unread } = props;
	return (
		<li className="hidden-room" style={accent}>
			<a className="hidden-room-link" href={hrefFor("room", view.key)}>
				<RoomPicture view={view} size={44} />
				<span className="room-row-main">
					<span className="room-row-top">
						<strong>{view.displayName}</strong>
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
					<span className="meta">
						{[
							props.at ? ago(props.at, props.now, props.timeZone) : "",
							props.preview,
						]
							.filter(Boolean)
							.join(" · ")}
					</span>
				</span>
			</a>
			<button
				type="button"
				className="secondary compact"
				onClick={() => void hideRoom(view.key, false)}
			>
				{t("Unhide")}
			</button>
			<button
				type="button"
				className="icon-button row-more"
				aria-haspopup="menu"
				aria-label={t("Room menu")}
				onClick={(event) => {
					const button = event.currentTarget;
					roomMenuOf(view.key).then(
						(spec) => {
							if (!spec) return;
							const box = button.getBoundingClientRect();
							openMenu({
								...spec,
								at: { x: box.left, y: box.bottom },
								via: "key",
								source: button,
							});
						},
						() => undefined,
					);
				}}
			>
				<Icon name="more" size={18} />
			</button>
		</li>
	);
});

/**
 * The hidden rooms and the archived knights and groups, where the chat home's one collapsed row
 * leads: a hidden room is shown again here, an archived one is restored or, behind its menu, deleted
 * for good. Dispatch threads whose room is gone are listed here too.
 */
export default function HiddenPage() {
	installChatsHomeStyle();
	const { now } = useLive();
	const { timeZone } = useConfig();
	const shape = useSelector((state) =>
		JSON.stringify(sections(state, (key) => activityAt(state, key))),
	);
	const { hidden, orphans } = useMemo(
		() => JSON.parse(shape) as Sections,
		[shape],
	);
	const rows = useRowData(hidden);
	const unread = useUnreadMap();
	return (
		<div className="page">
			<header className="page-head">
				<h1>{t("Hidden and archived")}</h1>
			</header>
			<section className="stack">
				<h2 className="section-title">
					{t("Hidden")} {hidden.length}
				</h2>
				<p className="meta">
					{t(
						"Hidden rooms still answer and run their schedules; new messages only count here.",
					)}
				</p>
				{hidden.length === 0 ? (
					<p className="meta">{t("No room is hidden.")}</p>
				) : (
					<ul className="room-list hidden-list">
						{rows.map(({ key, ...row }) => (
							<HiddenRoom
								key={key}
								{...row}
								now={now}
								timeZone={timeZone}
								unread={unread[key] ?? 0}
							/>
						))}
					</ul>
				)}
			</section>
			{orphans.open.length + orphans.closed.length > 0 ? (
				<section className="stack">
					<h2 className="section-title">{t("Dispatch threads")}</h2>
					<ThreadList
						open={orphans.open}
						closed={orphans.closed}
						active={undefined}
					/>
				</section>
			) : null}
			<section className="stack">
				<h2 className="section-title">{t("Archived")}</h2>
				<ArchiveList deleteIn="menu" />
				<p className="meta">
					{t("Deleting for good is under the ⋯ menu, and asks first.")}
				</p>
			</section>
		</div>
	);
}
