import { definePlugin } from "pi-roundtable";

/**
 * Loads the Pi package pi-self-compact in every conversation session. Its compact_session tool
 * lets a turn compact a long conversation; every session carries it, so startup stops with
 * "required tools are not registered: compact_session" when no plugin loads it.
 */
export const selfCompact = definePlugin({
	name: "self-compact",
	setup: () => ({ piPackages: ["pi-self-compact"] }),
});
