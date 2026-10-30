import { useState } from "react";
import { HELPERS_ENDED, type RoomMessage } from "../../src/api-types.ts";
import { useSelector } from "../lib/app-store.ts";
import { translate as t } from "../lib/messages.ts";
import { Icon } from "./icons.tsx";

/** The knight's line that it archived its temp knights, with the undo: the names the server wrote, or none when the line is not readable. */
function endedHelpers(text: string): { name: string; displayName: string }[] {
	if (!text.startsWith(HELPERS_ENDED)) return [];
	try {
		const value: unknown = JSON.parse(text.slice(HELPERS_ENDED.length));
		return Array.isArray(value)
			? value.flatMap((one) =>
					typeof one?.name === "string" && typeof one?.displayName === "string"
						? [{ name: one.name, displayName: one.displayName }]
						: [],
				)
			: [];
	} catch {
		return [];
	}
}

/** "<knight> archived 2 temp knights: a, b" and a button that puts them back. */
export function HelpersEndedLine(props: {
	message: RoomMessage;
	enter: boolean;
}) {
	const helpers = endedHelpers(props.message.text);
	const knight = useSelector(
		(state) => state.rooms[props.message.room]?.view?.displayName ?? "",
	);
	const [done, setDone] = useState(false);
	const values = {
		name: knight,
		count: helpers.length,
		names: helpers.map((one) => one.displayName).join(", "),
	};
	return (
		<li className="line" data-enter={props.enter || undefined}>
			<Icon name="archive" size={14} />
			<span>
				{helpers.length === 1
					? t("{name} archived {count} temp knight: {names}", values)
					: t("{name} archived {count} temp knights: {names}", values)}
			</span>
			<button
				type="button"
				className="secondary compact"
				disabled={done}
				onClick={() => {
					setDone(true);
					void import("../lib/bulk-actions.ts").then((m) =>
						m.putBackHelpers(helpers.map((one) => one.name)),
					);
				}}
			>
				{t("Undo")}
			</button>
		</li>
	);
}
