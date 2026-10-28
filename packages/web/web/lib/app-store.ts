import { useRef, useSyncExternalStore } from "react";
import { type Action, initialState, type RoomsState, reduce } from "./rooms.ts";

/** The owner app's state, one for the page. Pages read it through `useSelector`. */
class Store {
	#state: RoomsState = initialState();
	readonly #listeners = new Set<() => void>();

	getState = (): RoomsState => this.#state;

	subscribe = (listener: () => void): (() => void) => {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	};

	dispatch = (action: Action): void => {
		const next = reduce(this.#state, action);
		if (next === this.#state) return;
		this.#state = next;
		for (const listener of this.#listeners) listener();
	};
}

export const store = new Store();

const shallow = (a: unknown, b: unknown): boolean => {
	if (Object.is(a, b)) return true;
	if (
		typeof a !== "object" ||
		typeof b !== "object" ||
		a === null ||
		b === null
	)
		return false;
	const left = Object.entries(a);
	const right = Object.entries(b);
	return (
		left.length === right.length &&
		left.every(([key, value]) =>
			Object.is(value, (b as Record<string, unknown>)[key]),
		)
	);
};

/**
 * What `select` picks out of the state; the component renders again only when the pick changes
 * (compared one level deep), so a streamed word in one room does not redraw the others.
 */
export function useSelector<T>(select: (state: RoomsState) => T): T {
	const last = useRef<{ state: RoomsState; value: T }>(undefined);
	const snapshot = (): T => {
		const state = store.getState();
		const previous = last.current;
		if (previous && previous.state === state) return previous.value;
		const value = select(state);
		const kept =
			previous && shallow(previous.value, value) ? previous.value : value;
		last.current = { state, value: kept };
		return kept;
	};
	return useSyncExternalStore(store.subscribe, snapshot, snapshot);
}
