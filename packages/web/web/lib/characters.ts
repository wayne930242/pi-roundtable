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
	// Shaded for the look's own surfaces: Camelot's parchment is darker than the modern page.
	const { look } = useCharacterStyle();
	if (!kit || !spec) return undefined;
	return { ["--agent-accent" as string]: kit.accentOf(spec, look) };
}

/** A room's accent: its agent's, and a thread wears its parent room's. For the pieces that sit in a room but not in its page. */
export function useRoomAccent(key: string): CSSProperties | undefined {
	const spec = useSelector((state) => {
		const view = state.rooms[key]?.view;
		return (
			view?.character ??
			(view?.parent ? state.rooms[view.parent]?.view?.character : undefined)
		);
	}, key);
	return useAccentStyle(spec);
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

/** Draws the component again just after `wait` ms, when a state it shows changes by then. */
function useRedrawIn(wait: number | undefined): void {
	const [, redraw] = useReducer((count: number) => count + 1, 0);
	useEffect(() => {
		if (wait === undefined) return;
		const timer = setTimeout(redraw, wait + 20);
		return () => clearTimeout(timer);
	}, [wait]);
}

/** The state a room's character shows now, redrawn when `done` or an old failure lapses. */
export function useRoomState(key: string): AvatarState {
	// The page's 30 s tick redraws the rules that depend on the hour.
	useLive();
	const input = useSelector((state) => presenceInputOf(state, key), key);
	useRedrawIn(stateChangesIn(input, Date.now()));
	return presenceOf(input, Date.now());
}

/**
 * The state of each of several rooms at once, by room key, redrawn when `done` or an old failure
 * lapses in any of them. The round table reads every seat's state through this.
 */
export function useRoomStates(
	keys: readonly string[],
): Record<string, AvatarState> {
	useLive();
	const state = useSelector((current) => current);
	const now = Date.now();
	const inputs = keys.map((key) => [key, presenceInputOf(state, key)] as const);
	useRedrawIn(
		inputs.reduce<number | undefined>((soonest, [, input]) => {
			const left = stateChangesIn(input, now);
			return left === undefined || (soonest !== undefined && soonest <= left)
				? soonest
				: left;
		}, undefined),
	);
	return Object.fromEntries(
		inputs.map(([key, input]) => [key, presenceOf(input, now)]),
	);
}

/** Whether a state moves the character; the idle and sleepy ones stand still in a list. */
export const movesIn = (state: AvatarState): boolean =>
	state !== "idle" && state !== "sleepy";
