import { useSyncExternalStore } from "react";

/**
 * What a module that keeps state of its own gives components: `emit` after the state changes,
 * and `use` to read it in a component, which draws again when it does.
 */
export function signal() {
	const listeners = new Set<() => void>();
	const subscribe = (listener: () => void) => {
		listeners.add(listener);
		return () => listeners.delete(listener);
	};
	return {
		emit(): void {
			for (const listener of listeners) listener();
		},
		use: <T>(read: () => T): T => useSyncExternalStore(subscribe, read, read),
	};
}
