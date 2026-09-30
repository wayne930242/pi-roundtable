import { definePlugin } from "pi-roundtable";

/** A service is a long-lived part: it starts once everything is set up and stops in reverse order at shutdown. */
export function heartbeat(everyMs: number, beat: () => Promise<void> | void) {
	let timer: ReturnType<typeof setInterval> | undefined;
	let running = 0;
	return definePlugin({
		name: "heartbeat",
		setup: () => ({
			services: [
				{
					name: "heartbeat-timer",
					start: () => {
						timer = setInterval(async () => {
							running++;
							try {
								await beat();
							} finally {
								running--;
							}
						}, everyMs);
					},
					stop: () => clearInterval(timer),
					// Shutdown waits until this list is empty, so a beat is never cut off.
					busy: () => (running > 0 ? ["a heartbeat is running"] : []),
				},
			],
		}),
	});
}
