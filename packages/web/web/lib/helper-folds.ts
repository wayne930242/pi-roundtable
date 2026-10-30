// Which knights' temp knights are folded on this device. A knight with a temp knight at work shows
// them unfolded and one whose are all finished shows them folded, until the person chose otherwise.

import { signal } from "./signal.ts";

export const HELPER_FOLDS_KEY = "roundtable-console:helpers-folded";

/** The person's own choice per knight's room: true folded, false unfolded. */
function load(): Readonly<Record<string, boolean>> {
	try {
		const raw = localStorage.getItem(HELPER_FOLDS_KEY);
		const value: unknown = raw ? JSON.parse(raw) : {};
		if (typeof value !== "object" || value === null || Array.isArray(value))
			return {};
		return Object.fromEntries(
			Object.entries(value).filter(
				(entry): entry is [string, boolean] => typeof entry[1] === "boolean",
			),
		);
	} catch {
		return {};
	}
}

let chosen: Readonly<Record<string, boolean>> | undefined;
const { emit, use } = signal();

const held = () => {
	chosen ??= load();
	return chosen;
};

/** Whether the knight's temp knights show folded: the person's choice, else folded when none is at work. */
export function useHelpersFolded(room: string, anyWorking: boolean): boolean {
	const choice = use(held)[room];
	return choice ?? !anyWorking;
}

/** Records the person's choice for a knight's room. */
export function setHelpersFolded(room: string, folded: boolean): void {
	chosen = { ...held(), [room]: folded };
	try {
		localStorage.setItem(HELPER_FOLDS_KEY, JSON.stringify(chosen));
	} catch {
		// A browser that refuses storage keeps the choice for this page only.
	}
	emit();
}

/** Re-reads the folds from storage; for a test that changes it. */
export function reloadHelperFolds(): void {
	chosen = undefined;
	emit();
}
