import { createContext, useContext, useEffect, useState } from "react";
import { EVENTS_URL } from "./api.ts";

/** How often relative times are redrawn and panes refetched even without a change. */
const TICK_MS = 30_000;

export interface Live {
	/** Counts every change the server reports and every tick; a pane refetches when it moves. */
	version: number;
	now: number;
	connected: boolean;
}

export const LiveContext = createContext<Live>({
	version: 0,
	now: Date.now(),
	connected: false,
});

export const useLive = () => useContext(LiveContext);

/** One event stream for the whole page: a `changed` event or a tick bumps the version. */
export function useLiveSource(): Live {
	const [live, setLive] = useState<Live>({
		version: 0,
		now: Date.now(),
		connected: false,
	});
	useEffect(() => {
		const bump = (connected?: boolean) =>
			setLive((current) => ({
				version: current.version + 1,
				now: Date.now(),
				connected: connected ?? current.connected,
			}));
		const events = new EventSource(EVENTS_URL);
		events.addEventListener("open", () => bump(true));
		events.addEventListener("error", () =>
			setLive((current) => ({ ...current, connected: false })),
		);
		events.addEventListener("changed", () => bump());
		const tick = setInterval(() => bump(), TICK_MS);
		return () => {
			events.close();
			clearInterval(tick);
		};
	}, []);
	return live;
}
