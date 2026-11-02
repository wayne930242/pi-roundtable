import { useSelector } from "../lib/app-store.ts";
import { translate as t } from "../lib/messages.ts";
import type { RoomCard } from "../lib/room-surface.ts";
import { hrefFor } from "../lib/router.ts";
import { PromptCard } from "./cards.tsx";

/**
 * One of the cards `roomCards` gives a view of a room, as every view draws it: the card, and over a
 * card carried up from a thread or temp knight's room a link to the room it was asked in.
 */
export function RoomCardBody(props: { entry: RoomCard; timeZone: string }) {
	const { entry } = props;
	const from = entry.from;
	const name = useSelector(
		(state) =>
			from === undefined
				? undefined
				: (state.rooms[from]?.view?.displayName ?? from),
		from ?? "",
	);
	return (
		<>
			{from !== undefined ? (
				<a className="card-from" href={hrefFor("room", from)}>
					{t("From {name}", { name: name ?? from })}
				</a>
			) : null}
			<PromptCard card={entry.card} timeZone={props.timeZone} />
		</>
	);
}
