import { AgentSheetHost } from "./agent-sheet.tsx";
import { RoomConfirmHost } from "./room-confirms.tsx";
import { TeamSheetHost } from "./team-sheets.tsx";

/** The questions and sheets that change an agent or the team, in one chunk the page names once. */
export function SheetHosts() {
	return (
		<>
			<RoomConfirmHost />
			<AgentSheetHost />
			<TeamSheetHost />
		</>
	);
}
