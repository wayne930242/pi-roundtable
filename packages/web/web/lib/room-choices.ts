// A yes-or-no choice the person made per room on this device, kept in local storage under one key:
// whether a knight's temp knights are folded, whether the drawer shows a room's threads.

import { signal } from "./signal.ts";

export interface RoomChoices {
	/** The person's choice for the room, or undefined when they made none. */
	use(room: string): boolean | undefined;
	set(room: string, value: boolean): void;
	/** Re-reads the choices from storage; for a test that changes it. */
	reload(): void;
}

export function roomChoices(storageKey: string): RoomChoices {
	const load = (): Readonly<Record<string, boolean>> => {
		try {
			const raw = localStorage.getItem(storageKey);
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
	};
	let chosen: Readonly<Record<string, boolean>> | undefined;
	const { emit, use } = signal();
	const held = () => {
		chosen ??= load();
		return chosen;
	};
	return {
		use: (room) => use(held)[room],
		set(room, value) {
			chosen = { ...held(), [room]: value };
			try {
				localStorage.setItem(storageKey, JSON.stringify(chosen));
			} catch {
				// A browser that refuses storage keeps the choice for this page only.
			}
			emit();
		},
		reload() {
			chosen = undefined;
			emit();
		},
	};
}
