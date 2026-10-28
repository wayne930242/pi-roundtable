import type { AvatarState, CharacterSpec } from "pi-roundtable/characters";
import { type CSSProperties, useEffect, useReducer } from "react";
import { useSelector } from "./app-store.ts";
import { useKit } from "./kit.ts";
import { useLive } from "./live.ts";
import { useCharacterStyle } from "./look.ts";
import { type PresenceInput, presenceOf, stateChangesIn } from "./presence.ts";
import { type RoomsState, waitingCards } from "./rooms.ts";

/** The custom property the stylesheet reads for an agent's accent, from its character; none until the kit has loaded. */
export function useAccentStyle(
	spec: CharacterSpec | undefined,
): CSSProperties | undefined {
	const kit = useKit();
	const { scheme } = useCharacterStyle();
	if (!kit || !spec) return undefined;
	return { ["--agent-accent" as string]: kit.accentOf(spec, scheme) };
}

/** Each agent's character, by name, from the agent rooms of the list. */
export function useCharacters(): Record<string, CharacterSpec> {
	return useSelector((state) => {
		const found: Record<string, CharacterSpec> = {};
		for (const room of Object.values(state.rooms))
			if (room.view?.kind === "agent" && room.view.character)
				found[room.view.name] = room.view.character;
		return found;
	});
}

/** What `presenceOf` needs from the state for one room. */
function presenceInputOf(state: RoomsState, key: string): PresenceInput {
	const room = state.rooms[key];
	const view = room?.view;
	return {
		typing: room?.typing ?? false,
		phase: room?.phase,
		prompts: waitingCards(state, key),
		outcome: room?.outcome,
		outcomeAt: room?.outcomeAt,
		// The page's own clock only: a message's server timestamp would skew the quiet time.
		lastActivityAt: room?.activityAt,
		busyElsewhere:
			view?.kind === "agent" && state.presence[view.name]?.busy === true,
	};
}

/** The state a room's character shows now, redrawn when `done` or an old failure lapses. */
export function useRoomState(key: string): AvatarState {
	// The page's 30 s tick redraws the rules that depend on the hour.
	useLive();
	const input = useSelector((state) => presenceInputOf(state, key), key);
	const [, redraw] = useReducer((count: number) => count + 1, 0);
	const wait = stateChangesIn(input, Date.now());
	useEffect(() => {
		if (wait === undefined) return;
		const timer = setTimeout(redraw, wait + 20);
		return () => clearTimeout(timer);
	}, [wait]);
	return presenceOf(input, Date.now());
}

/** Whether a state moves the character; the idle and sleepy ones stand still in a list. */
export const movesIn = (state: AvatarState): boolean =>
	state !== "idle" && state !== "sleepy";
