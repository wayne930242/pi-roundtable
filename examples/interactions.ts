import { definePlugin } from "pi-roundtable";
import { DISCORD } from "pi-roundtable/discord";

/**
 * Slash commands belong to the Discord plugin: a plugin adds its own from setup with
 * `commands.add`. A subcommand goes under the one root command (`/roundtable` by default); the
 * module answers the interactions Discord sends and returns true for the ones it handled.
 */
export const ping = definePlugin({
	name: "ping",
	setup: ({ services }) => {
		services.get(DISCORD).commands.add({
			rootOptions: [
				{ type: 1, name: "ping", description: "Check that the bot answers" },
			],
			module: {
				commands: () => [],
				handle: async (interaction) => {
					if (!interaction.isChatInputCommand()) return false;
					if (interaction.options.getSubcommand(false) !== "ping") return false;
					await interaction.reply("pong");
					return true;
				},
			},
		});
		return {};
	},
});
