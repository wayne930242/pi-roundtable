import { lazy, Suspense } from "react";
import { hostUi } from "../lib/frame-taps.ts";

// The count and its look load beside the first list that shows one.
const UnreadMark = lazy(() =>
	hostUi().then((ui) => ({ default: ui.UnreadMark })),
);

/** How many messages of a room the person has not read, as a badge; nothing when there are none. */
export function Unread({ room }: { room: string }) {
	return (
		<Suspense fallback={null}>
			<UnreadMark room={room} />
		</Suspense>
	);
}
