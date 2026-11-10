import { memo, useMemo, useState } from "react";
import { ArchiveListOf, useArchive } from "../components/archive-list.tsx";
import { DeleteForGood } from "../components/delete-confirm.tsx";
import { Icon } from "../components/icons.tsx";
import { RoomPicture } from "../components/room-picture.tsx";
import {
	type BarAction,
	IdleChips,
	SectionHead,
	SelectBar,
	SelectBox,
} from "../components/select-bar.tsx";
import { openMenu } from "../lib/action-menu.ts";
import { useSelector } from "../lib/app-store.ts";
import { useBatch } from "../lib/batch.ts";
import { useAccentStyle } from "../lib/characters.ts";
import { installChatsHomeStyle } from "../lib/chats-home-style.ts";
import { useConfig } from "../lib/config.ts";
import { ago } from "../lib/format.ts";
import {
	chosenIn,
	deleteBatch,
	deletion,
	dismissBatch,
	entryId,
	restoreBatch,
	toggleEntry,
	unhideBatch,
} from "../lib/hidden-batch.ts";
import { hideRoom } from "../lib/layout-actions.ts";
import { useLive } from "../lib/live.ts";
import { useLongPress } from "../lib/long-press.ts";
import { roomMenuOf } from "../lib/menus.ts";
import { plural, translate as t } from "../lib/messages.ts";
import { activityAt } from "../lib/rooms.ts";
import { hrefFor } from "../lib/router.ts";
import { type Sections, sections } from "../lib/sections.ts";
import {
	type Idle,
	idleCounts,
	idleRows,
	NOTHING,
	useSelecting,
} from "../lib/selection.ts";
import { useUnreadMap } from "../lib/unread-map.ts";
import { type RowData, ThreadList, useRowData } from "./rooms.tsx";

/** How a row is chosen while the page is selecting. */
interface Pick {
	selecting: boolean;
	chosen: boolean;
	toggle(): void;
	hold(): void;
}

/** One hidden room: it still answers, and shows when it last spoke; Unhide returns it to its place. */
const HiddenRoom = memo(function HiddenRoom(
	props: Omit<RowData, "key"> & {
		now: number;
		timeZone: string;
		unread: number;
		pick: Pick;
	},
) {
	const { view, pick } = props;
	const accent = useAccentStyle(view.character);
	const { unread } = props;
	const press = useLongPress((request) => {
		if (request.via === "hold") pick.hold();
	});
	const main = (
		<>
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
		</>
	);
	if (pick.selecting)
		return (
			<li className="hidden-room" style={accent}>
				<label
					className="select-row"
					data-chosen={pick.chosen ? "" : undefined}
				>
					<SelectBox
						label={view.displayName}
						checked={pick.chosen}
						onChange={pick.toggle}
					/>
					{main}
				</label>
			</li>
		);
	return (
		<li className="hidden-room" style={accent} {...press}>
			<a className="hidden-room-link" href={hrefFor("room", view.key)}>
				{main}
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

/** A dispatch thread whose room is gone, as a row to choose while the page is selecting. */
function ThreadChoice(props: {
	row: Omit<RowData, "key">;
	now: number;
	timeZone: string;
	pick: Pick;
}) {
	const { row, pick } = props;
	return (
		<li className="hidden-room">
			<label className="select-row" data-chosen={pick.chosen ? "" : undefined}>
				<SelectBox
					label={row.view.displayName}
					checked={pick.chosen}
					onChange={pick.toggle}
				/>
				<RoomPicture view={row.view} size={36} />
				<span className="room-row-main">
					<strong>{row.view.displayName}</strong>
					<span className="meta">
						{[
							row.view.closed ? t("Finished") : t("Still open"),
							row.at ? ago(row.at, props.now, props.timeZone) : "",
						]
							.filter(Boolean)
							.join(" · ")}
					</span>
				</span>
			</label>
		</li>
	);
}

const HIDDEN = "hidden";
const THREADS = "threads";
const ARCHIVED = "archived";

/**
 * The hidden rooms and the archived knights and groups, which the features grid
 * opens: a hidden room is shown again here, an archived one is restored or, behind its menu, deleted
 * for good. Dispatch threads whose room is gone are listed here too. "Select" (or holding a row)
 * lets each section be handled in bulk: unhide, dismiss, restore, or delete archived rows for good.
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
	const threadKeys = useMemo(
		() => [...orphans.open, ...orphans.closed],
		[orphans],
	);
	const rows = useRowData(hidden);
	const threadRows = useRowData(threadKeys);
	const unread = useUnreadMap();
	const archive = useArchive();
	const pick = useSelecting();
	const batch = useBatch(pick.clear);
	const [idle, setIdle] = useState<Idle>(0);
	const [asking, setAsking] = useState(false);

	const entries = archive.entries ?? [];
	const shown = pick.on
		? idleRows(entries, (one) => one.lastActive, now, idle)
		: entries;
	const named = new Map(
		[...rows, ...threadRows].map((row) => [row.key, row.view.displayName]),
	);
	const nameOf = (key: string) => named.get(key) ?? key;
	const roomPick = (section: string, key: string): Pick => ({
		selecting: pick.on,
		chosen: pick.has(section, key),
		toggle: () => pick.toggle(section, key),
		hold: () => pick.enter({ section, key }),
	});
	const inArchive = pick.section === ARCHIVED ? pick.keys : NOTHING.keys;
	const chooseEntry = (entry: (typeof entries)[number]) =>
		pick.set({
			section: ARCHIVED,
			keys: toggleEntry(inArchive, entries, entry),
		});
	const leave = () => {
		pick.leave();
		setIdle(0);
	};
	const allShown = shown.map(entryId);
	const doomed = deletion(entries, inArchive);
	const keys = [...pick.keys];

	const actions: BarAction[] =
		pick.section === HIDDEN
			? [
					{
						id: "unhide",
						label: t("Unhide"),
						onPress: () => void batch.start(unhideBatch(keys, nameOf)),
					},
				]
			: pick.section === THREADS
				? [
						{
							id: "dismiss",
							label: t("Dismiss"),
							onPress: () => void batch.start(dismissBatch(keys, nameOf)),
						},
					]
				: pick.section === ARCHIVED
					? [
							{
								id: "restore",
								label: t("Restore"),
								onPress: () =>
									void batch.start(
										restoreBatch(chosenIn(entries, inArchive), archive.load),
									),
							},
							{
								id: "delete",
								label: t("Delete for good"),
								tone: "danger",
								onPress: () => setAsking(true),
							},
						]
					: [];
	const helpers = doomed.gone.length - doomed.send.length;
	return (
		<div className="page">
			<header className="page-head">
				<h1>{t("Hidden and archived")}</h1>
				{hidden.length + threadKeys.length + entries.length > 0 ? (
					<button
						type="button"
						className="secondary compact"
						aria-pressed={pick.on}
						onClick={pick.on ? leave : () => pick.enter()}
					>
						{pick.on ? t("Done") : t("Select")}
					</button>
				) : null}
			</header>
			<section className="stack">
				<SectionHead
					title={
						<>
							{t("Hidden")} {hidden.length}
						</>
					}
					selecting={pick.on}
					empty={hidden.length === 0}
					allChosen={
						pick.section === HIDDEN &&
						hidden.length > 0 &&
						pick.keys.size === hidden.length
					}
					onAll={() => pick.all(HIDDEN, hidden)}
				/>
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
								pick={roomPick(HIDDEN, key)}
							/>
						))}
					</ul>
				)}
			</section>
			{threadKeys.length > 0 ? (
				<section className="stack">
					<SectionHead
						title={t("Dispatch threads")}
						selecting={pick.on}
						empty={false}
						allChosen={
							pick.section === THREADS && pick.keys.size === threadKeys.length
						}
						onAll={() => pick.all(THREADS, threadKeys)}
					/>
					{pick.on ? (
						<ul className="room-list hidden-list">
							{threadRows.map(({ key, ...row }) => (
								<ThreadChoice
									key={key}
									row={row}
									now={now}
									timeZone={timeZone}
									pick={roomPick(THREADS, key)}
								/>
							))}
						</ul>
					) : (
						<ThreadList
							open={orphans.open}
							closed={orphans.closed}
							active={undefined}
						/>
					)}
				</section>
			) : null}
			<section className="stack">
				<SectionHead
					title={
						<>
							{t("Archived")} {entries.length}
						</>
					}
					selecting={pick.on}
					empty={shown.length === 0}
					allChosen={
						pick.section === ARCHIVED &&
						allShown.length > 0 &&
						allShown.every((id) => pick.keys.has(id))
					}
					onAll={() =>
						pick.set({
							section: ARCHIVED,
							keys:
								allShown.length > 0 && allShown.every((id) => inArchive.has(id))
									? NOTHING.keys
									: new Set(allShown),
						})
					}
				/>
				{pick.on && entries.length > 0 ? (
					<IdleChips
						counts={idleCounts(entries, (one) => one.lastActive, now)}
						value={idle}
						onChange={(next) => {
							setIdle(next);
							if (pick.section === ARCHIVED) pick.clear();
						}}
					/>
				) : null}
				<ArchiveListOf
					source={archive}
					deleteIn="menu"
					shown={shown}
					select={{
						selecting: pick.on,
						chosen: inArchive,
						toggle: chooseEntry,
						hold: (entry) => {
							pick.enter();
							pick.set({
								section: ARCHIVED,
								keys: toggleEntry(NOTHING.keys, entries, entry),
							});
						},
					}}
				/>
				<p className="meta">
					{t("Deleting for good is under the ⋯ menu, and asks first.")}
				</p>
			</section>
			{pick.on ? (
				<SelectBar
					count={pick.keys.size}
					actions={actions}
					running={batch.running}
					outcome={batch.outcome}
					onDismiss={batch.dismiss}
				/>
			) : null}
			<DeleteForGood
				open={asking}
				names={doomed.gone.map((one) => one.displayName)}
				notes={[
					...(helpers > 0
						? [
								plural(
									helpers,
									"{count} temp knight goes with its knight.",
									"{count} temp knights go with their knights.",
								),
							]
						: []),
					t(
						"Their messages and threads in this app are deleted, and their names can be used again.",
					),
				]}
				onClose={() => setAsking(false)}
				onConfirm={async () => {
					void batch.start(deleteBatch(doomed.send, archive.load));
				}}
			/>
		</div>
	);
}
