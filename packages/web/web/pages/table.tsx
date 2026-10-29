import { useEffect, useState } from "react";
import { DialogueBox } from "../components/dialogue-box.tsx";
import { RoundTable, useRoster } from "../components/round-table.tsx";
import { useSelector } from "../lib/app-store.ts";
import { resolveFocus } from "../lib/dialogue.ts";
import { translate as t } from "../lib/messages.ts";
import { reducedMotion } from "../lib/motion.ts";
import { navigate } from "../lib/router.ts";
import type { TableHandle } from "../table/entry.ts";

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

/**
 * Every agent of the room list at the round table, each in the state its room is in. A seat turns the
 * camera to its agent and opens a dialogue box on the agent's own room; the address `#/table/<agent>`
 * is that view, so Back returns to the whole ring and a link opens the scene at an agent. `focus` is
 * the route's key: an agent's name or the key of its room.
 */
export function TablePage({ focus }: { focus?: string | undefined }) {
	const [table, setTable] = useState<TableHandle>();
	const roster = useRoster(undefined);
	const listed = useSelector((state) => state.listed);
	const target = resolveFocus(focus, roster);
	const view = roster.find((seat) => seat.name === target);
	// An address that names nobody seated goes back to the whole ring, in place: Back does not return to it.
	useEffect(() => {
		if (focus && listed && target === null)
			navigate("table", undefined, { replace: true });
	}, [focus, listed, target]);
	const arrived = useArrived(target !== null);
	const go = (name: string | null) => {
		if (name === target) return;
		// from the whole ring a push (Back returns to it); from one agent to another, or out, in place
		navigate("table", name ?? undefined, { replace: target !== null });
	};
	return (
		<div className="table-page" data-focused={target !== null || undefined}>
			<header className="page-head">
				<h1>{t("Round table")}</h1>
				{table?.kind === "webgl" ? (
					<button type="button" className="secondary" onClick={() => go(null)}>
						{t("Reset view")}
					</button>
				) : null}
			</header>
			<div className="table-frame">
				<RoundTable
					onHandle={setTable}
					focus={target}
					onFocus={go}
					onSeat={go}
				/>
				{view ? (
					<DialogueBox
						key={view.key}
						roomKey={view.key}
						open={arrived}
						onBack={() => go(null)}
					/>
				) : null}
			</div>
		</div>
	);
}
