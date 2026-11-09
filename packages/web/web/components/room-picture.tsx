import type { RoomView } from "../../src/api-types.ts";
import { movesIn, useCharacters, useRoomState } from "../lib/characters.ts";
import { CharacterStack, PageCharacter } from "./character.tsx";

/** A group's members' characters stacked, standing still. */
function GroupPicture(props: {
	members: readonly string[];
	size: number;
	bare?: boolean;
}) {
	const characters = useCharacters();
	return (
		<CharacterStack
			size={props.size}
			bare={props.bare}
			members={props.members.map((name) => ({ name, spec: characters[name] }))}
		/>
	);
}

/** An agent's character, live while it is doing something. */
function AgentPicture(props: { view: RoomView; size: number; bare?: boolean }) {
	const state = useRoomState(props.view.key);
	return (
		<PageCharacter
			spec={props.view.character}
			name={props.view.name}
			size={props.size}
			bare={props.bare}
			state={state}
			live={movesIn(state)}
		/>
	);
}

/** A room's picture: an agent's character, or a group's members; `bare` stands them free of any frame. */
export function RoomPicture(props: {
	view: RoomView;
	size: number;
	bare?: boolean;
}) {
	return props.view.kind === "group" ? (
		<GroupPicture
			members={props.view.members ?? []}
			size={props.size}
			bare={props.bare}
		/>
	) : (
		<AgentPicture view={props.view} size={props.size} bare={props.bare} />
	);
}
