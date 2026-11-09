import { useEffect, useState } from "react";
import { hostState } from "./frame-taps.ts";

const NONE: Readonly<Record<string, number>> = {};

/**
 * How many messages of each room the person has not read, as the page counts them. The counting
 * code is a chunk that loads with the first frame that needs it, so this asks for it by import and
 * draws again when a count moves; until it is here every room counts none.
 */
export function useUnreadMap(): Readonly<Record<string, number>> {
	const [counts, setCounts] = useState(NONE);
	useEffect(() => {
		let gone = false;
		let stop: (() => void) | undefined;
		hostState().then(
			(state) => {
				if (gone) return;
				const read = () =>
					setCounts((held) => {
						const next = state.unreadCounts();
						const same =
							Object.keys(next).length === Object.keys(held).length &&
							Object.entries(next).every(([key, count]) => held[key] === count);
						return same ? held : next;
					});
				read();
				stop = state.subscribeHost(read);
			},
			() => undefined,
		);
		return () => {
			gone = true;
			stop?.();
		};
	}, []);
	return counts;
}
