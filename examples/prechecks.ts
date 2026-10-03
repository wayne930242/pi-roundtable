import { definePlugin, PRECHECKS } from "pi-roundtable";

/** Last night's reading and its usual level, from wherever the host keeps them. */
export interface RecoveryReading {
	hrv: number;
	baseline: number;
}

/**
 * A precheck a daily schedule can name: the host reads the numbers first and wakes the agent
 * only when they are off, so an ordinary morning costs no model turn.
 */
export function recoveryPrecheck(read: () => Promise<RecoveryReading>) {
	return definePlugin({
		name: "recovery-precheck",
		setup: ({ services }) => {
			services.get(PRECHECKS).register({
				name: "health.recovery",
				description:
					"Reads last night's HRV; wakes you when it is a fifth or more under its baseline.",
				timeoutMs: 15_000,
				run: async () => {
					const { hrv, baseline } = await read();
					if (hrv >= baseline * 0.8)
						return { wake: false, note: `HRV ${hrv} ms, as usual.` };
					return {
						wake: true,
						context: `HRV ${hrv} ms against a baseline of ${baseline} ms.`,
					};
				},
			});
			return {};
		},
	});
}
