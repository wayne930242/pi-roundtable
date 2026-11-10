// Choosing several rows of one section of a page to act on them together: the state of the choice,
// the age filter that narrows a long section, and the hook that holds both. It belongs to the pages
// that offer a selection (hidden and archived, the overview), which are lazy chunks of their own.

import { useCallback, useEffect, useMemo, useState } from "react";
import { ago } from "./format.ts";
import { translate as t } from "./messages.ts";

const DAY = 86_400_000;

/** The age filters a long section offers, in days without activity; 0 shows every row. */
export const IDLE_STEPS = [0, 7, 30] as const;
export type Idle = (typeof IDLE_STEPS)[number];

/** Whether a row with no activity since `at` (never, when absent) has been idle for `days` or more. */
export function idleFor(
	at: string | undefined,
	now: number,
	days: Idle,
): boolean {
	if (days === 0) return true;
	const time = at ? Date.parse(at) : Number.NaN;
	return Number.isNaN(time) || now - time >= days * DAY;
}

/** The rows idle for `days` or more, in their order. */
export const idleRows = <T>(
	rows: readonly T[],
	atOf: (row: T) => string | undefined,
	now: number,
	days: Idle,
): T[] => rows.filter((row) => idleFor(atOf(row), now, days));

/** How many rows each filter shows. */
export const idleCounts = <T>(
	rows: readonly T[],
	atOf: (row: T) => string | undefined,
	now: number,
): Record<Idle, number> => ({
	0: rows.length,
	7: idleRows(rows, atOf, now, 7).length,
	30: idleRows(rows, atOf, now, 30).length,
});

/** `3 d ago` from a day on, however old, and the usual `5 min ago` before it. */
export function lastActive(
	at: string | undefined,
	now: number,
	timeZone: string,
): string {
	if (!at) return t("No messages yet");
	const days = Math.floor((now - Date.parse(at)) / DAY);
	return days >= 1
		? t("{count} d ago", { count: days })
		: ago(at, now, timeZone);
}

/** What is chosen: the keys, all of one section. */
export interface Chosen {
	section: string | undefined;
	keys: ReadonlySet<string>;
}

export const NOTHING: Chosen = { section: undefined, keys: new Set() };

/** Flips `key` in `section`; a choice in another section than the held one starts over there. */
export function flip(chosen: Chosen, section: string, key: string): Chosen {
	if (chosen.section !== section) return { section, keys: new Set([key]) };
	const keys = new Set(chosen.keys);
	if (!keys.delete(key)) keys.add(key);
	return { section, keys };
}

/** Chooses exactly `keys` of `section`, or nothing when they are all chosen already. */
export function flipAll(
	chosen: Chosen,
	section: string,
	keys: readonly string[],
): Chosen {
	const same =
		chosen.section === section &&
		keys.length > 0 &&
		keys.length === chosen.keys.size &&
		keys.every((key) => chosen.keys.has(key));
	return same ? NOTHING : { section, keys: new Set(keys) };
}

/** The selection mode of a page: whether it is on, what is chosen, and the ways to change both. */
export interface Selecting {
	on: boolean;
	section: string | undefined;
	keys: ReadonlySet<string>;
	has(section: string, key: string): boolean;
	/** Turns the mode on, with `first` chosen when the mode was entered by holding a row. */
	enter(first?: { section: string; key: string }): void;
	leave(): void;
	toggle(section: string, key: string): void;
	/** Replaces the choice with `chosen`, which a caller that groups rows (a knight with its temp knights) works out. */
	set(chosen: Chosen): void;
	all(section: string, keys: readonly string[]): void;
	clear(): void;
}

export function useSelecting(): Selecting {
	const [on, setOn] = useState(false);
	const [chosen, setChosen] = useState<Chosen>(NOTHING);
	const enter = useCallback((first?: { section: string; key: string }) => {
		setOn(true);
		if (first) setChosen((now) => flip(now, first.section, first.key));
	}, []);
	const leave = useCallback(() => {
		setOn(false);
		setChosen(NOTHING);
	}, []);
	const toggle = useCallback(
		(section: string, key: string) =>
			setChosen((now) => flip(now, section, key)),
		[],
	);
	const all = useCallback(
		(section: string, keys: readonly string[]) =>
			setChosen((now) => flipAll(now, section, keys)),
		[],
	);
	const clear = useCallback(() => setChosen(NOTHING), []);
	// Escape leaves the mode, unless a dialog or sheet is open: that one takes the key.
	useEffect(() => {
		if (!on) return;
		const key = (event: KeyboardEvent) => {
			if (event.key !== "Escape" || event.defaultPrevented) return;
			if (document.querySelector("dialog[open]")) return;
			leave();
		};
		window.addEventListener("keydown", key);
		return () => window.removeEventListener("keydown", key);
	}, [on, leave]);
	return useMemo(
		() => ({
			on,
			section: chosen.section,
			keys: chosen.keys,
			has: (section, key) => chosen.section === section && chosen.keys.has(key),
			enter,
			leave,
			toggle,
			set: setChosen,
			all,
			clear,
		}),
		[on, chosen, enter, leave, toggle, all, clear],
	);
}
