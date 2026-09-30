import { definePlugin } from "pi-roundtable";

/**
 * Interactions add slash commands. A subcommand goes under the one root command (`/roundtable`
 * by default); the module answers the interactions Discord sends and returns true for the ones it handled.
 */
export const ping = definePlugin({
	name: "ping",
	setup: () => ({
		interactions: [
			{
				rootOptions: [
					{ type: 1, name: "ping", description: "Check that the bot answers" },
				],
				module: {
					commands: () => [],
					handle: async (interaction) => {
						if (!interaction.isChatInputCommand()) return false;
						if (interaction.options.getSubcommand(false) !== "ping")
							return false;
						await interaction.reply("pong");
						return true;
					},
				},
			},
		],
	}),
});
