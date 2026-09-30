import { definePlugin } from "pi-roundtable";

/**
 * A channel claim makes a plugin the owner of the conversations in some channels. The router
 * asks claims by descending priority; the first that owns a channel decides everything there,
 * and a message its `admit` returns nothing for is dropped.
 */
export const echo = definePlugin({
	name: "echo",
	setup: () => ({
		channels: [
			{
				name: "echo-channels",
				priority: 10,
				owns: (channel) => channel.startsWith("echo:"),
				admit: (message) => ({
					kind: "turn",
					run: async () => {
						console.log(`echo: ${message.text}`);
					},
					failure: "an echo turn failed",
				}),
				startFresh: async () => "The echo channel has nothing to start over.",
			},
		],
	}),
});
