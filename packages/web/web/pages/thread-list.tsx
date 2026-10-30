import { memo, useEffect, useRef } from "react";
import type { RoomView } from "../../src/api-types.ts";
import { Icon } from "../components/icons.tsx";
import { RoomPicture } from "../components/room-picture.tsx";
import { Unread } from "../components/unread.tsx";
import { useSelector } from "../lib/app-store.ts";
import { useRoomAccent } from "../lib/characters.ts";
import { useConfig } from "../lib/config.ts";
import { ago } from "../lib/format.ts";
import { useLive } from "../lib/live.ts";
import { plural, translate as t } from "../lib/messages.ts";
import { hrefFor } from "../lib/router.ts";
import {
	type RowData,
	type ThreadListProps,
	Typing,
	useRowData,
	WaitingBadge,
} from "./rooms.tsx";

/**
 * A dispatch thread under its room, as a card: its title, its room's knight, whether it is going on or
 * finished, and when it last said something. A finished one swipes right to clear itself (the card is
 * the gestures' target; they load beside the first list of cards), and its menu button opens the same
 * menu as a hold or a right click.
 */
const ThreadCard = memo(function ThreadCard(
	props: Omit<RowData, "key"> & {
		active: boolean;
		now: number;
		timeZone: string;
		/** The room the thread hangs under, for the knight's picture. */
		parent: RoomView | undefined;
	},
) {
	const { view, parent } = props;
	const accent = useRoomAccent(view.key);
	const finished = Boolean(view.closed);
	return (
		<li className="thread-item">
			{finished ? (
				<span className="thread-reveal" aria-hidden="true">
					<Icon name="trash" size={18} />
					{t("Clear")}
				</span>
			) : null}
			<div
				className="thread-card"
				data-hold="row"
				data-thread={view.key}
				data-closed={finished ? "" : undefined}
				style={accent}
			>
				<a
					className="thread-link"
					href={hrefFor("room", view.key)}
					aria-current={props.active ? "page" : undefined}
				>
					{parent ? (
						<RoomPicture view={parent} size={36} />
					) : (
						<Icon name="conversations" size={20} className="thread-row-icon" />
					)}
					<span className="thread-card-main">
						<span className="thread-card-top">
							<strong className="thread-title">{view.displayName}</strong>
							<Unread room={view.key} />
							<span className="room-row-time">
								{props.at ? ago(props.at, props.now, props.timeZone) : ""}
							</span>
						</span>
						<span className="thread-card-meta">
							{props.typing ? <Typing /> : null}
							<span className={finished ? "badge" : "badge badge-accent"}>
								{finished ? t("Finished") : t("In progress")}
							</span>
							{props.waiting ? <WaitingBadge count={props.waiting} /> : null}
						</span>
					</span>
				</a>
				{finished ? (
					<button
						type="button"
						className="thread-more"
						aria-haspopup="menu"
						aria-label={t("More actions for {name}", {
							name: view.displayName,
						})}
						onClick={(event) => {
							const button = event.currentTarget;
							const card = button.closest<HTMLElement>(".thread-card");
							const box = button.getBoundingClientRect();
							if (card)
								void import("../lib/thread-cards.ts").then((m) =>
									m.openCardMenu(card, { x: box.right, y: box.bottom }, "key"),
								);
						}}
					>
						<Icon name="more" size={18} />
					</button>
				) : null}
			</div>
		</li>
	);
});

/** The threads of a room as cards: the open ones, then the finished ones folded away until asked for, with a way to clear them. */
export default function ThreadCards(props: ThreadListProps) {
	const { now } = useLive();
	const { timeZone } = useConfig();
	const open = useRowData(props.open);
	const closed = useRowData(props.closed);
	const parent = useSelector(
		(state) => (props.parent ? state.rooms[props.parent]?.view : undefined),
		props.parent ?? "",
	);
	const group = useRef<HTMLDivElement>(null);
	const any = open.length + closed.length > 0;
	useEffect(() => {
		const root = group.current;
		if (!any || !root) return;
		let gone = false;
		let detach: (() => void) | undefined;
		import("../lib/thread-cards.ts").then((m) => {
			if (!gone) detach = m.attachThreadCards(root);
		});
		return () => {
			gone = true;
			detach?.();
		};
	}, [any]);
	if (!any) return null;
	const card = ({ key, ...rest }: RowData) => (
		<ThreadCard
			key={key}
			{...rest}
			active={key === props.active}
			now={now}
			timeZone={timeZone}
			parent={parent}
		/>
	);
	return (
		<div className="thread-group" ref={group} data-parent={props.parent}>
			{open.length ? (
				<ul className="thread-list" aria-label={t("Dispatch threads")}>
					{open.map(card)}
				</ul>
			) : null}
			{closed.length ? (
				<div className="thread-finished">
					<details
						className="thread-closed"
						{...(closed.some((one) => one.key === props.active)
							? { open: true }
							: {})}
					>
						<summary>
							{plural(
								closed.length,
								"{count} finished thread",
								"{count} finished threads",
							)}
						</summary>
						<ul className="thread-list">{closed.map(card)}</ul>
					</details>
					<button
						type="button"
						className="thread-clear"
						onClick={() =>
							import("../lib/thread-actions.ts").then((m) =>
								m.clearFinished(
									props.parent,
									closed.map((one) => one.key),
								),
							)
						}
					>
						{t("Clear finished")}
					</button>
				</div>
			) : null}
		</div>
	);
}
