import { useEffect, useState } from "react";
import type { HostRoomSummaryView } from "../../src/host/views.ts";
import { messageOf } from "../lib/api.ts";
import { useSelector } from "../lib/app-store.ts";
import { useConfig } from "../lib/config.ts";
import { ago } from "../lib/format.ts";
import { hostApi } from "../lib/host-api.ts";
import { seedUnread, useHost } from "../lib/host-state.ts";
import "../lib/host-icons.ts";
import { installHostStyle } from "../lib/host-style.ts";
import { useLive } from "../lib/live.ts";
import { translate as t } from "../lib/messages.ts";
import { hrefFor } from "../lib/router.ts";
import { HostPicture } from "./host-picture.tsx";
import { Icon, type IconName } from "./icons.tsx";
import { Empty, Failure } from "./states.tsx";
import UnreadMark from "./unread-mark.tsx";

installHostStyle();

/** A list longer than this gets a box that filters it. */
const FILTER_FROM = 6;
const TYPING_PAUSE_MS = 250;

/** The rooms of one kind of host room this person may open: the picture, the title, what was last said, and how many are unread. */
export default function HostKindSection(props: {
	kind: string;
	label: string;
	icon?: IconName;
	active: string | undefined;
}) {
	const { kind } = props;
	const { timeZone } = useConfig();
	const { now } = useLive();
	const connects = useSelector((state) => state.connects);
	const changed = useHost((state) => state.lists[kind] ?? 0);
	const [typed, setTyped] = useState("");
	const [filter, setFilter] = useState("");
	const [rooms, setRooms] = useState<HostRoomSummaryView[]>();
	const [cursor, setCursor] = useState<string>();
	const [error, setError] = useState<string>();
	const [more, setMore] = useState(false);

	useEffect(() => {
		const timer = setTimeout(() => setFilter(typed.trim()), TYPING_PAUSE_MS);
		return () => clearTimeout(timer);
	}, [typed]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: the kind, the filter, the connection count and the host's change counter say when to fetch
	useEffect(() => {
		let current = true;
		hostApi.list(kind, filter || undefined).then(
			(list) => {
				if (!current) return;
				seedUnread(
					Object.fromEntries(
						list.rooms.map((room) => [room.key, room.unread ?? 0]),
					),
				);
				setRooms(list.rooms);
				setCursor(list.cursor);
				setError(undefined);
			},
			(failure) => current && setError(messageOf(failure)),
		);
		return () => {
			current = false;
		};
	}, [kind, filter, connects, changed]);

	const loadMore = async () => {
		if (!cursor || more) return;
		setMore(true);
		try {
			const list = await hostApi.list(kind, filter || undefined, cursor);
			seedUnread(
				Object.fromEntries(
					list.rooms.map((room) => [room.key, room.unread ?? 0]),
				),
			);
			setRooms((was) => [...(was ?? []), ...list.rooms]);
			setCursor(list.cursor);
		} catch (failure) {
			setError(messageOf(failure));
		} finally {
			setMore(false);
		}
	};

	return (
		<section className="stack">
			<h2 className="section-title">
				{props.icon ? (
					<Icon name={props.icon} size={14} className="section-icon" />
				) : null}
				{props.label}
			</h2>
			{rooms && (rooms.length >= FILTER_FROM || filter || typed) ? (
				<input
					type="search"
					className="kind-filter"
					value={typed}
					placeholder={t("Search {name}", { name: props.label })}
					aria-label={t("Search {name}", { name: props.label })}
					onChange={(event) => setTyped(event.target.value)}
				/>
			) : null}
			{error ? <Failure message={error} /> : null}
			{!rooms && !error ? (
				<div className="stack" aria-busy="true">
					<div className="skeleton" />
					<div className="skeleton" />
				</div>
			) : null}
			{rooms && rooms.length === 0 ? (
				<Empty>{filter ? t("Nothing matches.") : t("No rooms yet.")}</Empty>
			) : null}
			{rooms && rooms.length > 0 ? (
				<ul className="room-list">
					{rooms.map((room) => (
						<li key={room.key}>
							<a
								className="room-row"
								href={hrefFor("room", room.key)}
								aria-current={room.key === props.active ? "page" : undefined}
							>
								<span className="kind-row-picture">
									<HostPicture
										picture={room.picture}
										name={room.title}
										size={44}
									/>
									{room.attention ? (
										<span
											className="attention-dot"
											role="img"
											aria-label={t("Needs attention")}
										/>
									) : null}
								</span>
								<span className="room-row-main">
									<span className="room-row-top">
										<strong>{room.title}</strong>
										<UnreadMark room={room.key} />
										<span className="room-row-time">
											{room.lastAt ? ago(room.lastAt, now, timeZone) : ""}
										</span>
									</span>
									<span className="room-row-preview">
										<span>{room.subtitle ?? ""}</span>
									</span>
								</span>
								<Icon name="chevron" size={16} className="room-row-chevron" />
							</a>
						</li>
					))}
				</ul>
			) : null}
			{cursor ? (
				<button
					type="button"
					className="secondary"
					disabled={more}
					onClick={loadMore}
				>
					{more ? t("Loading…") : t("Show more")}
				</button>
			) : null}
		</section>
	);
}
