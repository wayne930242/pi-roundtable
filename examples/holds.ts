import { definePlugin, defineTool } from "pi-roundtable";
import { Type } from "typebox";

/** Holds make a call wait for the owner's approval; the description is what the owner is asked to approve. */
export const cleanup = definePlugin({
	name: "cleanup",
	setup: () => ({
		tools: [
			defineTool({
				name: "file_delete",
				description: "Delete a file in the shared workspace.",
				parameters: Type.Object({ path: Type.String() }),
				minTier: "admin",
				// Returning text holds this call; returning undefined lets it run.
				hold: ({ path }) => `Delete ${path}`,
				run: ({ path }) => `Deleted ${path}.`,
			}),
		],
		// A rule sees every tool call, whoever defined the tool.
		holdRules: [
			{
				name: "cleanup-production",
				describe: (tool, input) =>
					JSON.stringify(input).includes("production")
						? `${tool} touches production`
						: undefined,
			},
		],
	}),
});
