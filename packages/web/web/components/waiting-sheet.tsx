import { useEffect, useRef } from "react";
import { useSelector } from "../lib/app-store.ts";
import { useConfig } from "../lib/config.ts";
import { ago } from "../lib/format.ts";
import { useLive } from "../lib/live.ts";
import { translate as t } from "../lib/messages.ts";
import {
	closeWaitingList,
	jumpToCard,
	useWaitingList,
	waitingList,
} from "../lib/waiting.ts";
import { Sheet } from "./sheet.tsx";

/** The cards waiting on the person, one row each (title, room, age); a row goes to its card. */
export function WaitingSheetHost() {
	const open = useWaitingList();
	const asked = useRef(false);
	if (open) asked.current = true;
	// Drawn once it has been asked for; it stays mounted afterwards so closing can animate.
	return asked.current ? <WaitingSheet open={open} /> : null;
}

function WaitingSheet({ open }: { open: boolean }) {
	const config = useConfig();
	const { now } = useLive();
	const rows = useSelector((state) =>
		waitingList(state).map(({ id, card }) => {
			const view = state.rooms[card.room]?.view;
			const parent = view?.parent ? state.rooms[view.parent]?.view : undefined;
			return {
				id,
				room: parent
					? `${parent.displayName} › ${view?.displayName ?? ""}`
					: (view?.displayName ?? card.room),
				title: card.frame.title,
				at: card.frame.at,
			};
		}),
	);
	const empty = rows.length === 0;
	// The last card answered elsewhere leaves nothing to list.
	useEffect(() => {
		if (open && empty) closeWaitingList();
	}, [open, empty]);
	return (
		<Sheet
			open={open && !empty}
			title={t("Cards waiting")}
			onClose={closeWaitingList}
		>
			<ul className="waiting-list">
				{rows.map((row) => (
					<li key={row.id}>
						<button type="button" onClick={() => jumpToCard(row.id)}>
							<strong>{row.title}</strong>
							<span className="meta">
								{row.room}
								{row.at ? ` · ${ago(row.at, now, config.timeZone)}` : ""}
							</span>
						</button>
					</li>
				))}
			</ul>
		</Sheet>
	);
}
