import {
	type AccessConfig,
	definePlugin,
	defineTool,
	IDENTITY,
	ToolRefusal,
} from "pi-roundtable";
import { Type } from "typebox";

/** One person may have several identities; surface roles never make an owner. */
export const access = {
	owners: [
		{
			principal: "operator",
			name: "Ada",
			identities: ["discord:966666600000000001", "token:remote-mcp"],
		},
	],
	members: { roles: ["web:role:App.User"] },
	provisioning: "admitted",
} satisfies AccessConfig;

/** Ask about the current principal, not the external actor or the primary owner. */
export const principals = definePlugin({
	name: "principals",
	requires: [IDENTITY],
	setup: ({ services }) => {
		const identity = services.get(IDENTITY);
		return {
			tools: [
				defineTool({
					name: "principal_who",
					description: "Show who this turn is for.",
					parameters: Type.Object({}),
					minTier: "member",
					run: async (_args, turn) => {
						if (!turn.speaker)
							throw new ToolRefusal("No speaker for this turn.");
						const person = await identity.principal(turn.speaker.principalId);
						if (!person || person.disabled)
							throw new ToolRefusal("This principal is not available.");
						return `${person.displayName} (${person.id})`;
					},
				}),
			],
		};
	},
});
