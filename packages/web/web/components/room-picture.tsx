import type { RoomView } from "../../src/api-types.ts";
import { movesIn, useCharacters, useRoomState } from "../lib/characters.ts";
import { CharacterStack, PageCharacter } from "./character.tsx";

/** A group's members' characters stacked, standing still. */
function GroupPicture(props: { members: readonly string[]; size: number }) {
	const characters = useCharacters();
	return (
		<CharacterStack
			size={props.size}
			members={props.members.map((name) => ({ name, spec: characters[name] }))}
		/>
	);
}

/** An agent's character, live while it is doing something. */
function AgentPicture(props: { view: RoomView; size: number }) {
	const state = useRoomState(props.view.key);
	return (
		<PageCharacter
			spec={props.view.character}
			name={props.view.name}
			size={props.size}
			state={state}
			live={movesIn(state)}
		/>
	);
}

/** A room's picture: an agent's character, or a group's members. */
export function RoomPicture(props: { view: RoomView; size: number }) {
	return props.view.kind === "group" ? (
		<GroupPicture members={props.view.members ?? []} size={props.size} />
	) : (
		<AgentPicture view={props.view} size={props.size} />
	);
}
