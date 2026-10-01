import { type BackgroundTarget, definePlugin } from "pi-roundtable";

/**
 * Whose turn a schedule or a delegated task asks for. The target sets what may be scheduled or
 * delegated for it, so a desk open to many people is held tighter than the owner's own agent.
 */
const SUPPORT: BackgroundTarget = {
	name: "support",
	label: () => "Support desk",
	schedules: { perChannel: 3, promptChars: 500, aheadDays: 30 },
	delegation: { maxRunning: 1 },
};

/**
 * A plugin that answers the turns nobody wrote in its channels. The router skips a turn whose
 * target no plugin contributes, and this claim skips the targets it does not serve, so another
 * target's schedule never runs here.
 */
export const supportDesk = definePlugin({
	name: "support-desk",
	setup: () => ({
		backgroundTargets: [SUPPORT],
		channels: [
			{
				name: "support-desks",
				priority: 10,
				owns: (channel) => channel.startsWith("support:"),
				admit: () => undefined,
				background: async (turn) =>
					turn.target === SUPPORT.name
						? { status: "ran" }
						: {
								status: "skipped",
								reason: `the support desk does not serve "${turn.target}"`,
							},
				startFresh: async () => "support",
			},
		],
	}),
});
