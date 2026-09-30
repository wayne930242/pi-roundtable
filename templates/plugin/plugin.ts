import { definePlugin, defineTool } from "pi-roundtable";
import { Type } from "typebox";

/** A plugin adds parts to the bot; this one adds a single tool the agents can call. */
export const __IDENT__ = definePlugin({
	name: "__NAME__",
	setup: () => ({
		tools: [
			defineTool({
				name: "__TOOL___greet",
				description: "Greet someone by name. Call it when asked to say hello.",
				parameters: Type.Object({ who: Type.String() }),
				minTier: "member",
				run: ({ who }) => `Hello, ${who}!`,
			}),
		],
	}),
});
