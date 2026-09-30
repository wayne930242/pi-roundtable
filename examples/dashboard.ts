import { definePlugin } from "pi-roundtable";

/** Dashboard lines are shown under the title of the agent server's dashboard message, in plugin order. */
export const links = definePlugin({
	name: "links",
	setup: () => ({
		dashboard: ["Docs: https://example.com/docs"],
	}),
});
