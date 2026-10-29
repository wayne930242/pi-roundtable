import type { ServerFrame } from "../../src/api-types.ts";

/** The frames the read state and the host rooms' pages keep; their code loads with the first of them. */
const WANTED =
	/^(host_|read$|message$|room_changed$|list_changed$|page_changed$)/;

/** Hands a frame to the lazy code that keeps the read state, the host cards and the host lists. */
export function tapFrame(frame: ServerFrame): void {
	if (WANTED.test(frame.type))
		import("./host-state.ts").then(
			(state) => state.onFrame(frame),
			() => undefined,
		);
}
