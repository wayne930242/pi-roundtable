import { definePlugin } from "pi-roundtable";
import { Type } from "typebox";

/**
 * A session tool is a Pi extension added to every conversation session: the raw form of `tools`,
 * for what defineTool cannot express. The factory returns null for a session it does not apply
 * to, and a new `revision` rebuilds open sessions on their next turn.
 */
export const clock = definePlugin({
	name: "clock",
	setup: () => ({
		sessionTools: [
			{
				name: "clock",
				phase: "tools",
				snapshot: () => ({
					revision: 0,
					factory: () => (pi) => {
						pi.registerTool({
							name: "clock_now",
							label: "clock_now",
							description: "Tell the current UTC time.",
							parameters: Type.Object({}),
							execute: async () => ({
								content: [{ type: "text", text: new Date().toISOString() }],
								details: undefined,
							}),
						});
					},
				}),
			},
		],
	}),
});
