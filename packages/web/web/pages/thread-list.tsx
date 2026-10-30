import { memo, useEffect, useRef } from "react";
import type { RoomView } from "../../src/api-types.ts";
import { Icon } from "../components/icons.tsx";
import { RoomPicture } from "../components/room-picture.tsx";
import { Unread } from "../components/unread.tsx";
import { useSelector } from "../lib/app-store.ts";
import { useRoomAccent } from "../lib/characters.ts";
import { useConfig } from "../lib/config.ts";
import { ago } from "../lib/format.ts";
import { setHelpersFolded, useHelpersFolded } from "../lib/helper-folds.ts";
import { installHelperStyle } from "../lib/helper-style.ts";
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

installHelperStyle();

/** One temp knight under its knight: a small face, its name, and whether it works, waits for the owner or has ended. */
const HelperRow = memo(function HelperRow(
	props: Omit<RowData, "key"> & {
		active: boolean;
		now: number;
		timeZone: string;
	},
) {
	const { view } = props;
	const finished = view.helper?.finished === true;
	return (
		<li>
			<a
				className="helper-link"
				href={hrefFor("room", view.key)}
				data-helper={view.name}
				data-finished={finished ? "" : undefined}
				aria-current={props.active ? "page" : undefined}
			>
				<RoomPicture view={view} size={20} />
				<strong>{view.displayName}</strong>
				<Unread room={view.key} />
				<span className="helper-state">
					{props.waiting ? <WaitingBadge count={props.waiting} /> : null}
					{!finished && !props.waiting ? (
						<span className="helper-dot" role="img" aria-label={t("Working")} />
					) : null}
					{finished ? <span>{t("Ended")}</span> : null}
					{finished && props.at ? (
						<span className="room-row-time">
							{ago(props.at, props.now, props.timeZone)}
						</span>
					) : null}
				</span>
			</a>
		</li>
	);
});

/** A knight's temp knights, folded away or open; open while one is at work unless the person chose otherwise. */
function HelperRows(props: {
	keys: string[];
	parent: string | undefined;
	active: string | undefined;
}) {
	const { now } = useLive();
	const { timeZone } = useConfig();
	const rows = useRowData(props.keys);
	const working = rows.some((row) => row.view.helper?.finished !== true);
	const room = props.parent ?? "";
	const folded = useHelpersFolded(room, working);
	// A temp knight that is open now shows, whatever the fold says.
	const shown =
		!folded || rows.some((row) => row.key === props.active) ? rows : [];
	if (rows.length === 0) return null;
	return (
		<div className="helper-group" data-parent={props.parent}>
			<button
				type="button"
				className="helper-head"
				aria-expanded={shown.length > 0}
				onClick={() => setHelpersFolded(room, shown.length > 0)}
			>
				{plural(rows.length, "{count} temp knight", "{count} temp knights")}
			</button>
			{shown.length > 0 ? (
				<ul className="helper-list">
					{shown.map(({ key, ...rest }) => (
						<HelperRow
							key={key}
							{...rest}
							active={key === props.active}
							now={now}
							timeZone={timeZone}
						/>
					))}
				</ul>
			) : null}
		</div>
	);
}

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
						</span>
						<span className="thread-card-meta">
							{props.typing ? <Typing /> : null}
							<span className={finished ? "badge" : "badge badge-accent"}>
								{finished ? t("Finished") : t("In progress")}
							</span>
							{props.waiting ? <WaitingBadge count={props.waiting} /> : null}
							<span className="room-row-time">
								{props.at ? ago(props.at, props.now, props.timeZone) : ""}
							</span>
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
	// The temp knights of the room come in among its open threads, and hang above them.
	const rows = useRowData(props.open);
	const helpers = rows.filter((row) => row.view.helper).map((row) => row.key);
	const open = rows.filter((row) => !row.view.helper);
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
	if (!any && helpers.length === 0) return null;
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
	if (!any)
		return (
			<HelperRows keys={helpers} parent={props.parent} active={props.active} />
		);
	return (
		<>
			{helpers.length ? (
				<HelperRows
					keys={helpers}
					parent={props.parent}
					active={props.active}
				/>
			) : null}
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
		</>
	);
}
