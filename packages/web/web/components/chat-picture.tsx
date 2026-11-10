import type { AvatarState, Expression } from "pi-roundtable/characters";
import type { RoomView } from "../../src/api-types.ts";
import { movesIn, useCharacters, useRoomState } from "../lib/characters.ts";
import { phaseOf } from "../lib/figure-motion.ts";
import { CharacterStack, PageCharacter } from "./character.tsx";

/** An idle agent rests with its eyes closed, so a home full of idle figures does not blink in unison; every other state keeps the kit's expression. */
const expressionOf = (state: AvatarState): Expression | undefined =>
	state === "idle" ? "resting" : undefined;

/**
 * A room's picture on the chat home, whose style moves the parts of a figure: a `pin` moves them at
 * rest too, a `row` only while its agent does something. A group's members each show the group's
 * state and loop at a phase of their own, so they do not move in step.
 */
export function ChatPicture(props: {
	view: RoomView;
	size: number;
	motion: "pin" | "row";
}) {
	const { view, size, motion } = props;
	return view.kind === "group" ? (
		<MovingGroup view={view} size={size} always={motion === "pin"} />
	) : (
		<MovingAgent view={view} size={size} always={motion === "pin"} />
	);
}

function MovingGroup(props: { view: RoomView; size: number; always: boolean }) {
	const characters = useCharacters();
	const state = useRoomState(props.view.key);
	const live = props.always || movesIn(state);
	return (
		<CharacterStack
			size={props.size}
			members={(props.view.members ?? []).map((name) => ({
				name,
				spec: characters[name],
			}))}
			figure={(member) => (
				// A wrapper that draws no box carries the member's own phase down to its figure.
				<span
					style={{
						display: "contents",
						["--phase" as string]: phaseOf(`${props.view.key}:${member.name}`),
					}}
				>
					<PageCharacter
						spec={member.spec}
						name={member.name}
						size={props.size}
						state={state}
						expr={expressionOf(state)}
						live={live}
					/>
				</span>
			)}
		/>
	);
}

function MovingAgent(props: { view: RoomView; size: number; always: boolean }) {
	const state = useRoomState(props.view.key);
	return (
		<PageCharacter
			spec={props.view.character}
			name={props.view.name}
			size={props.size}
			state={state}
			expr={expressionOf(state)}
			live={props.always || movesIn(state)}
		/>
	);
}
