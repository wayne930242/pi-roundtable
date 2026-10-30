import { lazy, Suspense, useContext, useEffect, useState } from "react";
import { DialogueBox } from "../components/dialogue-box.tsx";
import {
	RoundTable,
	useAgents,
	useRoster,
} from "../components/round-table.tsx";
import { openMenu } from "../lib/action-menu.ts";
import { useSelector } from "../lib/app-store.ts";
import { ConfigContext } from "../lib/config.ts";
import { resolveFocus } from "../lib/dialogue.ts";
import {
	useHostedTable,
	useHostSeats,
	useHostSeatsSync,
	useSeatsHostRooms,
} from "../lib/host-seats.ts";
import type { Via } from "../lib/long-press.ts";
import { seatMenuOf } from "../lib/menus.ts";
import { translate as t } from "../lib/messages.ts";
import { reducedMotion } from "../lib/motion.ts";
import { navigate } from "../lib/router.ts";
import type { SeatMenuRequest, TableHandle } from "../table/entry.ts";

// Who sits is chosen in a sheet that loads when it is first asked for.
const TableSeatsSheet = lazy(() =>
	import("../components/table-seats.tsx").then((m) => ({
		default: m.TableSeatsSheet,
	})),
);

/** How long the box waits for the camera before it slides up: it arrives with the turn, not after it. */
const ARRIVE_MS = 300;

/** True a moment after `on` turned true, at once when it turns false; no wait under reduced motion. */
function useArrived(on: boolean): boolean {
	const [arrived, setArrived] = useState(false);
	useEffect(() => {
		if (!on) {
			setArrived(false);
			return;
		}
		if (reducedMotion()) {
			setArrived(true);
			return;
		}
		const timer = setTimeout(() => setArrived(true), ARRIVE_MS);
		return () => clearTimeout(timer);
	}, [on]);
	return arrived;
}

/** Opens the menu of an agent's seat; its builder loads with the first menu. */
function openSeatMenu(
	key: string,
	at: SeatMenuRequest["at"],
	via: Via,
	source: HTMLElement | null,
): void {
	seatMenuOf(key).then(
		(spec) => {
			if (spec) openMenu({ ...spec, at, via, source });
		},
		() => undefined,
	);
}

/** Keeps the host rooms of a table: the rooms of the kinds the person may list. */
function HostSeatsSync() {
	useHostSeatsSync(
		(useContext(ConfigContext)?.kinds ?? []).map((kind) => kind.kind),
	);
	return null;
}

/**
 * Every agent of the room list whose room is not muted at the round table, each in the state its room is in. A seat turns the
 * camera to its agent and opens a dialogue box on the agent's own room; the address `#/table/<agent>`
 * is that view, so Back returns to the whole ring and a link opens the scene at an agent. `focus` is
 * the route's key: an agent's name or the key of its room.
 *
 * A person who is not an owner has no agent rooms. Their ring seats the host rooms their kinds list
 * for them, and a seat opens the room's own page, where what they may write and press is decided as it
 * is anywhere else; the table has no dialogue box, no seat menu and no sheet of who sits for them.
 */
export function TablePage({ focus }: { focus?: string | undefined }) {
	const [table, setTable] = useState<TableHandle>();
	const roster = useRoster(undefined);
	const agents = useAgents();
	const [choosing, setChoosing] = useState(false);
	// Mounted when first asked for and kept, so the sheet can slide away.
	const [asked, setAsked] = useState(false);
	const hosted = useHostedTable();
	const seatsHostRooms = useSeatsHostRooms();
	const hostSeats = useHostSeats();
	const ownerListed = useSelector((state) => state.listed);
	const listed = hosted
		? hostSeats.loaded
		: ownerListed && (!seatsHostRooms || hostSeats.loaded);
	// An owner's table also seats host rooms; they are not agents, so the camera, box and menu skip them.
	const hostKeys = new Set(hostSeats.views.map((one) => one.key));
	const agentRoster = hosted
		? roster
		: roster.filter((one) => !hostKeys.has(one.key));
	// A hosted seat opens its room's page; the camera and the dialogue box are the owners'.
	const target = hosted ? null : resolveFocus(focus, agentRoster);
	const view = agentRoster.find((seat) => seat.name === target);
	// An address that names nobody seated goes back to the whole ring, in place: Back does not return to it.
	useEffect(() => {
		if (focus && listed && target === null)
			navigate("table", undefined, { replace: true });
	}, [focus, listed, target]);
	const arrived = useArrived(target !== null);
	const go = (name: string | null) => {
		if (hosted) {
			// A hosted seat opens its room's own page; there is no close-up to turn the camera to.
			const seated = roster.find((one) => one.name === name);
			if (seated) navigate("room", seated.key);
			return;
		}
		const hostRoom = roster.find((one) => one.name === name);
		if (hostRoom && hostKeys.has(hostRoom.key)) {
			navigate("room", hostRoom.key);
			return;
		}
		if (name === target) return;
		// from the whole ring a push (Back returns to it); from one agent to another, or out, in place
		navigate("table", name ?? undefined, { replace: target !== null });
	};
	const choose = () => {
		setAsked(true);
		setChoosing(true);
	};
	// Everyone is off the table, but there are agents to call back: say so, and offer the sheet.
	const empty = !hosted && roster.length === 0 && agents.length > 0;
	const noRooms = hosted && hostSeats.loaded && roster.length === 0;
	return (
		<div className="table-page" data-focused={target !== null || undefined}>
			<header className="page-head">
				<h1>{t("Round table")}</h1>
				<div className="table-tools">
					{table?.kind === "webgl" ? (
						<button
							type="button"
							className="secondary"
							onClick={() => go(null)}
						>
							{t("Reset view")}
						</button>
					) : null}
					{!hosted && agents.length > 0 ? (
						<button
							type="button"
							className="secondary"
							aria-haspopup="dialog"
							onClick={choose}
						>
							{t("Who's at the table")}
						</button>
					) : null}
				</div>
			</header>
			<div className="table-frame" data-focused={target !== null || undefined}>
				{empty ? (
					<div className="table-empty-state">
						<strong>{t("The table is empty")}</strong>
						<p className="meta">
							{t("Every knight has left the table. Choose who sits down.")}
						</p>
						<button type="button" onClick={choose}>
							{t("Who's at the table")}
						</button>
					</div>
				) : noRooms ? (
					<div className="table-empty-state">
						<strong>{t("The table is empty")}</strong>
						<p className="meta">{t("There are no rooms to seat yet.")}</p>
					</div>
				) : (
					<RoundTable
						onHandle={setTable}
						focus={target}
						onFocus={go}
						onSeat={go}
						{...(hosted
							? { onMore: () => navigate("rooms") }
							: {
									onSeatMenu: (request: SeatMenuRequest) => {
										const seated = agentRoster.find(
											(one) => one.name === request.id,
										);
										if (seated)
											openSeatMenu(
												seated.key,
												request.at,
												request.via,
												request.source,
											);
									},
								})}
					/>
				)}
				{seatsHostRooms ? <HostSeatsSync /> : null}
				{view ? (
					<DialogueBox
						key={view.key}
						roomKey={view.key}
						open={arrived}
						onBack={() => go(null)}
						onMenu={(anchor) => {
							const box = anchor.getBoundingClientRect();
							openSeatMenu(
								view.key,
								{ x: box.left, y: box.bottom },
								"key",
								anchor,
							);
						}}
					/>
				) : null}
			</div>
			{asked ? (
				<Suspense fallback={null}>
					<TableSeatsSheet open={choosing} onClose={() => setChoosing(false)} />
				</Suspense>
			) : null}
		</div>
	);
}
