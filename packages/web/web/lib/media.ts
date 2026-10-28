import { useSyncExternalStore } from "react";

/** Whether a media query matches now, and again when it changes. False where there is no `matchMedia`. */
export function useMedia(query: string): boolean {
	const subscribe = (notify: () => void) => {
		if (typeof matchMedia !== "function") return () => undefined;
		const list = matchMedia(query);
		list.addEventListener("change", notify);
		return () => list.removeEventListener("change", notify);
	};
	return useSyncExternalStore(
		subscribe,
		() => typeof matchMedia === "function" && matchMedia(query).matches,
		() => false,
	);
}
