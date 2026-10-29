import { useEffect } from "react";
import { Loading } from "../components/states.tsx";
import { openAgentSheet } from "../lib/agent-sheet.ts";
import { useSelector } from "../lib/app-store.ts";
import { navigate } from "../lib/router.ts";

/**
 * An agent's old page, `#/agent/<name>`: a bookmark, an installed app's history or a link from
 * before the sheet. It stands in for the agent's room with the sheet open on top, and leaves no
 * history entry of its own, so Back goes where it would have gone from the room.
 */
export function AgentPage({ name }: { name: string }) {
	const listed = useSelector((state) => state.listed);
	const room = useSelector(
		(state) =>
			Object.values(state.rooms).find(
				(one) => one.view?.kind === "agent" && one.view.name === name,
			)?.view?.key,
		name,
	);
	useEffect(() => {
		if (room) {
			navigate("room", room, { replace: true });
			openAgentSheet(name);
		} else if (listed) navigate("rooms", undefined, { replace: true });
	}, [room, listed, name]);
	return (
		<div className="page">
			<Loading />
		</div>
	);
}
