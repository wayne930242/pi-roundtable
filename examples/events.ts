import { definePlugin } from "pi-roundtable";

/** Handlers hear what the core does. One that throws is logged and never stops the others. */
export function turnLog(lines: string[]) {
	return definePlugin({
		name: "turn-log",
		setup: () => ({
			events: {
				turnStarted: (turn) => {
					lines.push(`${turn.agent} started`);
				},
				turnEnded: (turn) => {
					lines.push(`${turn.agent} ${turn.result}`);
				},
				changed: () => {
					lines.push("team changed");
				},
				// The drain is over, and no service has stopped yet.
				shutdown: (left) => {
					lines.push(`shutdown, ${left.length} unfinished`);
				},
			},
		}),
	});
}
