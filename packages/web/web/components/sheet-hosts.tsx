import { lazy, Suspense, useRef } from "react";
import { useShortcutHelp } from "../lib/shortcut-help.ts";
import { AgentSheetHost } from "./agent-sheet.tsx";
import { ArchivedSheetHost } from "./archived-sheet.tsx";
import { RoomConfirmHost } from "./room-confirms.tsx";
import { SelectTextSheetHost } from "./select-text-sheet.tsx";
import { TeamSheetHost } from "./team-sheets.tsx";
import { WaitingSheetHost } from "./waiting-sheet.tsx";

// The shortcut list's drawing is a chunk of its own that waits for the first `?`.
const ShortcutHelp = lazy(() => import("./shortcut-help.tsx"));

/** Draws the shortcut list once it has been asked for; it stays mounted afterwards so closing can animate. */
export function ShortcutHelpHost() {
	const open = useShortcutHelp();
	const asked = useRef(false);
	if (open) asked.current = true;
	if (!asked.current) return null;
	return (
		<Suspense fallback={null}>
			<ShortcutHelp open={open} />
		</Suspense>
	);
}

/** The questions and sheets that change an agent or the team, in one chunk the page names once. */
export function SheetHosts() {
	return (
		<>
			<RoomConfirmHost />
			<AgentSheetHost />
			<TeamSheetHost />
			<ArchivedSheetHost />
			<SelectTextSheetHost />
			<WaitingSheetHost />
			<ShortcutHelpHost />
		</>
	);
}
