import { useId, useState } from "react";
import type { RoomView } from "../../src/api-types.ts";
import { translate as t } from "../lib/messages.ts";
import { setRoomMuted } from "../lib/mute.ts";
import { RoomPicture } from "./room-picture.tsx";
import { useAgents } from "./round-table.tsx";
import { Sheet } from "./sheet.tsx";
import { Switch } from "./switch.tsx";

/** One agent and the switch that seats it: on while its room is not muted. */
function SeatRow({ view }: { view: RoomView }) {
	const id = useId();
	const [busy, setBusy] = useState(false);
	const off = view.muted === true;
	return (
		<li>
			<label className="menu-item menu-toggle seat-row" htmlFor={id}>
				<RoomPicture view={view} size={40} />
				<span className="menu-text">
					<strong>{view.displayName}</strong>
					{off ? <span className="meta">{t("Off the table")}</span> : null}
				</span>
				<Switch
					id={id}
					checked={!off}
					label={view.displayName}
					busy={busy}
					onChange={async (next) => {
						setBusy(true);
						await setRoomMuted(view.key, !next);
						setBusy(false);
					}}
				/>
			</label>
		</li>
	);
}

/**
 * Who sits at the round table: every agent with a switch. Taking an agent off the table mutes its
 * room's push for every owner and device, the same switch the agent's sheet and the room menu have,
 * so the table, the room list and the sheet always agree.
 */
export function TableSeatsSheet(props: { open: boolean; onClose(): void }) {
	const agents = useAgents();
	return (
		<Sheet
			open={props.open}
			title={t("Who's at the table")}
			onClose={props.onClose}
		>
			<div className="stack table-seats">
				<p className="meta">
					{t(
						"An agent who leaves the table is muted: its room stops pushing to you. A card that waits for you is always pushed.",
					)}
				</p>
				<ul className="menu">
					{agents.map((view) => (
						<SeatRow key={view.key} view={view} />
					))}
				</ul>
			</div>
		</Sheet>
	);
}
