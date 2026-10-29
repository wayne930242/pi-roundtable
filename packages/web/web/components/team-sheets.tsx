import { useEffect, useRef } from "react";
import { translate as t } from "../lib/messages.ts";
import {
	closeTeamSheet,
	type TeamSheetRequest,
	useTeamSheet,
} from "../lib/team-sheet.ts";
import { ArchiveList } from "./archive-list.tsx";
import { GroupEditor } from "./group-editor.tsx";
import { NewAgent } from "./new-agent.tsx";
import { Sheet } from "./sheet.tsx";

const titleOf = (ask: TeamSheetRequest): string =>
	ask.kind === "new-agent"
		? t("New agent")
		: ask.kind === "archive"
			? t("Archived")
			: ask.name === undefined
				? t("New group")
				: t("Edit group");

/** Draws the sheet that `openTeamSheet` asks for, wherever in the page it was asked. */
export function TeamSheetHost() {
	const ask = useTeamSheet();
	const last = useRef(ask);
	if (ask) last.current = ask;
	const shown = last.current;
	const asked = ask !== undefined;
	// A sheet belongs to the page it was opened on: a step of the history or a new address takes it away.
	useEffect(() => {
		if (!asked) return;
		const at = window.location.href;
		const onMove = () => {
			if (window.location.href !== at) closeTeamSheet();
		};
		window.addEventListener("popstate", onMove);
		window.addEventListener("hashchange", onMove);
		return () => {
			window.removeEventListener("popstate", onMove);
			window.removeEventListener("hashchange", onMove);
		};
	}, [asked]);
	if (!shown) return null;
	return (
		<Sheet
			open={ask !== undefined}
			title={titleOf(shown)}
			size="wide"
			onClose={closeTeamSheet}
		>
			<div className="stack agent-sheet" key={shown.id}>
				{shown.kind === "new-agent" ? (
					<NewAgent onDone={closeTeamSheet} />
				) : shown.kind === "archive" ? (
					<ArchiveList />
				) : (
					<GroupEditor
						{...(shown.name === undefined ? {} : { name: shown.name })}
						onDone={closeTeamSheet}
					/>
				)}
			</div>
		</Sheet>
	);
}
