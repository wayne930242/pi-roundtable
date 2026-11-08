import type { ServerFrame } from "../../src/api-types.ts";

/** The code that keeps the read state and the host rooms' state; it loads with the first frame that needs it. */
export const hostState = () => import("./host-state.ts");

/** The pages and parts of the host rooms; they load where a host's room, page or read mark first shows. */
export const hostUi = () => import("../components/host-ui.tsx");

/** The frames the read state and the host rooms' pages keep. */
const WANTED =
	/^(host_|read$|message$|room_changed$|list_changed$|page_changed$)/;

/** Hears every frame, for a lazy part that waits for the server's word, such as a block's answer. */
export const frameListeners = new Set<(frame: ServerFrame) => void>();

/** Hands a frame to the lazy code that keeps the read state, the host cards and the host lists. */
export function tapFrame(frame: ServerFrame): void {
	for (const listen of frameListeners) listen(frame);
	if (WANTED.test(frame.type))
		hostState().then(
			(state) => state.onFrame(frame),
			() => undefined,
		);
}
