import { lazy, Suspense, useContext, useEffect, useState } from "react";
import type { RoomView } from "../../src/api-types.ts";
import { GroupStage, useGroupFocus } from "../components/group-scene.tsx";
import {
	RoundTable,
	useAgents,
	useRoster,
} from "../components/round-table.tsx";
import { openMenu } from "../lib/action-menu.ts";
import { useSelector } from "../lib/app-store.ts";
import { ConfigContext } from "../lib/config.ts";
import { councilOf, useChosenCouncil, useCouncils } from "../lib/council.ts";
import {
	useHostedTable,
	useHostSeats,
	useHostSeatsSync,
} from "../lib/host-seats.ts";
import type { Via } from "../lib/long-press.ts";
import { seatMenuOf } from "../lib/menus.ts";
import { translate as t } from "../lib/messages.ts";
import { navigate } from "../lib/router.ts";
import type { SeatMenuRequest, TableHandle } from "../table/entry.ts";

// Who sits is chosen in a sheet that loads when it is first asked for.
const CouncilSheet = lazy(() =>
	import("../components/council-sheet.tsx").then((m) => ({
		default: m.CouncilSheet,
	})),
);

/** Opens the menu of a council member's seat; its builder loads with the first menu. */
function openSeatMenu(
	key: string,
	council: string,
	at: SeatMenuRequest["at"],
	via: Via,
	source: HTMLElement | null,
): void {
	seatMenuOf(key, council).then(
		(spec) => {
			if (spec) openMenu({ ...spec, at, via, source });
		},
		() => undefined,
	);
}

/** Keeps the host rooms of a hosted table: the rooms of the kinds the person may list. */
function HostSeatsSync() {
	useHostSeatsSync(
		(useContext(ConfigContext)?.kinds ?? []).map((kind) => kind.kind),
	);
	return null;
}

/**
 * The table of a person who is not an owner. They have no agent rooms, so the ring seats the host
 * rooms their kinds list for them, newest first and at most as many as the ring holds; a seat
 * opens the room's own page, where what they may write and press is decided as it is anywhere else.
 * The table has no dialogue box, no seat menu and no council for them; the rest of their rooms are
 * in the room list, which a button in the header opens.
 */
function HostedTable({ focus }: { focus: string | undefined }) {
	const [table, setTable] = useState<TableHandle>();
	const roster = useRoster(undefined);
	const hostSeats = useHostSeats();
	const noRooms = hostSeats.loaded && roster.length === 0;
	// An address that names a seat is no close-up here: it goes back to the whole ring, in place.
	useEffect(() => {
		if (focus && hostSeats.loaded)
			navigate("table", undefined, { replace: true });
	}, [focus, hostSeats.loaded]);
	return (
		<div className="table-page">
			<header className="page-head">
				<h1>{t("Round table")}</h1>
				<div className="table-tools">
					{table?.kind === "webgl" ? (
						<button
							type="button"
							className="secondary"
							onClick={() => table.focus(null)}
						>
							{t("Reset view")}
						</button>
					) : null}
					<button
						type="button"
						className="secondary"
						onClick={() => navigate("rooms")}
					>
						{t("All rooms")}
					</button>
				</div>
			</header>
			<div className="table-frame">
				{noRooms ? (
					<div className="table-empty-state">
						<strong>{t("The table is empty")}</strong>
						<p className="meta">{t("There are no rooms to seat yet.")}</p>
					</div>
				) : (
					<RoundTable
						onHandle={setTable}
						onSeat={(name) => {
							const seated = roster.find((one) => one.name === name);
							if (seated) navigate("room", seated.key);
						}}
						onFocus={(name) => {
							// A camera turn by the person opens the room at once: there is no close-up here.
							const seated = roster.find((one) => one.name === name);
							if (seated) navigate("room", seated.key);
						}}
					/>
				)}
				<HostSeatsSync />
			</div>
		</div>
	);
}

/**
 * The owner's round table is a council: one agent group, its members (at most eight) at the
 * podiums and the group's room in the dialogue box, so a message sent here starts a round under the
 * group's rules. A tap on a seat turns the camera to that member; holding it opens the seat's menu,
 * which has the private chat. The council sheet picks, edits and saves councils.
 *
 * The address `#/table/<group>` is the council; without one the table shows the council this device
 * looked at last, or the first group.
 */
function CouncilTable({ named }: { named: string | undefined }) {
	const [table, setTable] = useState<TableHandle>();
	const councils = useCouncils();
	const chosen = useChosenCouncil();
	const listed = useSelector((state) => state.listed);
	const council = councilOf(councils, chosen, named);
	const members = council?.members ?? [];
	const roster = useRoster(members);
	const agents = useAgents();
	const { focus, look } = useGroupFocus(council?.key ?? "", members);
	const [choosing, setChoosing] = useState(false);
	// Mounted when first asked for and kept, so the sheet can slide away.
	const [asked, setAsked] = useState(false);
	const choose = () => {
		setAsked(true);
		setChoosing(true);
	};
	// An address that names no group goes back to the plain table, in place: Back does not return to it.
	const known = named === undefined || councils.some(sameCouncil(named));
	useEffect(() => {
		if (named !== undefined && listed && !known)
			navigate("table", undefined, { replace: true });
	}, [named, listed, known]);
	const seated = roster.length > 0;
	return (
		<div className="table-page" data-focused={seated || undefined}>
			<header className="page-head">
				<h1>{t("Round table")}</h1>
				<div className="table-tools">
					{table?.kind === "webgl" ? (
						<button
							type="button"
							className="secondary"
							onClick={() => look(null)}
						>
							{t("Reset view")}
						</button>
					) : null}
					{agents.length > 0 ? (
						<button
							type="button"
							className="secondary council-chip"
							aria-haspopup="dialog"
							onClick={choose}
						>
							{council
								? t("Council: {name} ▾", { name: council.displayName })
								: t("Pick who sits")}
						</button>
					) : null}
				</div>
			</header>
			{council && seated ? (
				<GroupStage
					roomKey={council.key}
					members={members}
					focus={focus}
					onLook={look}
					streams
					onHandle={setTable}
					onSeatMenu={(request: SeatMenuRequest) => {
						const one = roster.find((view) => view.name === request.id);
						if (one)
							openSeatMenu(
								one.key,
								council.key,
								request.at,
								request.via,
								request.source,
							);
					}}
				/>
			) : (
				<div className="table-frame">
					<div className="table-empty-state">
						<strong>
							{council ? t("The council is empty") : t("No council yet")}
						</strong>
						<p className="meta">
							{council
								? t("Every member of this council is gone. Edit who sits.")
								: t(
										"A council is a group of up to {max} knights who answer in turn.",
										{ max: 8 },
									)}
						</p>
						{agents.length > 0 ? (
							<button type="button" onClick={choose}>
								{council ? t("Edit this council") : t("Pick who sits")}
							</button>
						) : null}
					</div>
				</div>
			)}
			{asked ? (
				<Suspense fallback={null}>
					<CouncilSheet
						open={choosing}
						onClose={() => setChoosing(false)}
						council={council}
					/>
				</Suspense>
			) : null}
		</div>
	);
}

const sameCouncil = (wanted: string) => (view: RoomView) =>
	view.key === wanted || view.name === wanted;

/**
 * The round table. An owner's is a council: an agent group at the podiums (`focus` is its group's
 * name). A person below the owners has no agent rooms, so their table seats the host rooms they may
 * list.
 */
export function TablePage({ focus }: { focus?: string | undefined }) {
	return useHostedTable() ? (
		<HostedTable focus={focus} />
	) : (
		<CouncilTable named={focus} />
	);
}
