// The sheets that change the team: a new agent, a group (new or edited), and the archive. A menu, a
// button or the room's header asks for one with `openTeamSheet`, and `TeamSheetHost` (mounted once,
// in the app) draws it.

import type { PresetView } from "../../src/api-types.ts";
import { signal } from "./signal.ts";

/** What a new knight's form starts from, such as a preset's fields; a copy, not a link. */
export type KnightSeed = Omit<PresetView, "name" | "sharedWith">;

export type TeamSheetRequest =
	| { kind: "new-agent"; from?: KnightSeed; id: number }
	/** A group's name edits it; without one the sheet makes a new group. */
	| { kind: "group"; name?: string; id: number }
	| { kind: "archive"; id: number };

type Ask =
	| { kind: "new-agent"; from?: KnightSeed }
	| { kind: "group"; name?: string }
	| { kind: "archive" };

let current: TeamSheetRequest | undefined;
let asks = 0;
const { emit, use } = signal();

/** Opens a sheet; one that is open changes to the one asked for. */
export function openTeamSheet(ask: Ask): void {
	asks += 1;
	current = { ...ask, id: asks };
	emit();
}

export function closeTeamSheet(): void {
	if (!current) return;
	current = undefined;
	emit();
}

export const useTeamSheet = (): TeamSheetRequest | undefined =>
	use(() => current);

/** The sheet that is open, if one is. */
export const currentTeamSheet = (): TeamSheetRequest | undefined => current;
