import { useEffect, useRef } from "react";
import { api } from "./api.ts";
import { store, useSelector } from "./app-store.ts";

/**
 * Fetches the room list at the start, after every `changed`, after every reconnect and on `version`
 * (the live stream's count). An answer is taken unless the answer of a later request was taken
 * already, so a run of `changed` frames that outpaces the fetch still lands the newest answer that
 * comes back, instead of dropping each one for the next and showing nothing until things go quiet.
 */
export function useRoomsSync(enabled: boolean, version: number): void {
	const revision = useSelector((state) => state.revision);
	const connects = useSelector((state) => state.connects);
	/** The newest request asked, and the newest whose answer the page took. */
	const asked = useRef(0);
	const taken = useRef(0);
	const alive = useRef(false);
	useEffect(() => {
		alive.current = enabled;
		return () => {
			alive.current = false;
		};
	}, [enabled]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: the counters say when to fetch
	useEffect(() => {
		if (!enabled) return;
		asked.current += 1;
		const request = asked.current;
		api.rooms().then(
			(view) => {
				if (!alive.current || request < taken.current) return;
				taken.current = request;
				store.dispatch({
					type: "rooms_loaded",
					rooms: view.rooms,
					pins: view.pins,
					folders: view.folders,
				});
			},
			() => undefined,
		);
	}, [enabled, revision, connects, version]);
}
