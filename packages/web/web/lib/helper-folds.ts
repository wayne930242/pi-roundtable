// Which knights' temp knights are folded on this device. A knight with a temp knight at work shows
// them unfolded and one whose are all finished shows them folded, until the person chose otherwise.

import { roomChoices } from "./room-choices.ts";

export const HELPER_FOLDS_KEY = "roundtable-console:helpers-folded";

/** The person's own choice per knight's room: true folded, false unfolded. */
const folds = roomChoices(HELPER_FOLDS_KEY);

/** Whether the knight's temp knights show folded: the person's choice, else folded when none is at work. */
export function useHelpersFolded(room: string, anyWorking: boolean): boolean {
	return folds.use(room) ?? !anyWorking;
}

/** Records the person's choice for a knight's room. */
export const setHelpersFolded = (room: string, folded: boolean): void =>
	folds.set(room, folded);

/** Re-reads the folds from storage; for a test that changes it. */
export const reloadHelperFolds = (): void => folds.reload();
