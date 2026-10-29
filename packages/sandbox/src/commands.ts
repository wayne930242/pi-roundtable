import type { QueuePort } from "pi-roundtable";
import {
	type CommandGuard,
	groupOption,
	type InteractionContribution,
	OwnerFacingError,
	ownerCommandModule,
} from "pi-roundtable/discord";
import type { SandboxChannelStore } from "./channel-store.ts";

/** Owner-only /roundtable sandbox on|off|status; mode changes use the same channel queue as turns. */
export function sandboxCommands(
	guard: CommandGuard,
	channels: Pick<
		SandboxChannelStore,
		"configured" | "disable" | "enable" | "has"
	>,
	queue: QueuePort,
): InteractionContribution {
	return {
		rootOptions: [
			groupOption((group) =>
				group
					.setName("sandbox")
					.setDescription("Manage this channel's sealed guest agent")
					.addSubcommand((sub) =>
						sub
							.setName("on")
							.setDescription(
								"Route mentions and replies into a sealed container",
							),
					)
					.addSubcommand((sub) =>
						sub
							.setName("off")
							.setDescription("Disable sandbox routing; keep channel memory"),
					)
					.addSubcommand((sub) =>
						sub
							.setName("status")
							.setDescription("Show whether this channel is sandboxed"),
					),
			),
		],
		module: ownerCommandModule(guard, {
			owns: (group) => group === "sandbox",
			command: async (interaction) => {
				if (!interaction.inGuild() || !interaction.channelId)
					throw new OwnerFacingError(
						"Sandbox commands require a guild channel.",
					);
				const channel = `discord:${interaction.channelId}` as const;
				const configured = channels.configured(
					interaction.guildId ?? undefined,
				);
				await queue.run(channel, async () => {
					const action = interaction.options.getSubcommand(true);
					if (configured) {
						await interaction.editReply(
							action === "off"
								? "This server is sandboxed by configuration (`guilds`); change the configuration to turn it off."
								: action === "on"
									? "Sandbox routing is already on: this server is sandboxed by configuration (`guilds`)."
									: "Sandbox routing is enabled: this server is sandboxed by configuration (`guilds`).",
						);
						return;
					}
					if (action === "on") channels.enable(channel);
					else if (action === "off") channels.disable(channel);
					await interaction.editReply(
						channels.has(channel)
							? "Sandbox routing is enabled. Mention the bot or reply to it to start a sealed turn."
							: "Sandbox routing is disabled. Memory is retained; normal host routing applies again.",
					);
				});
			},
		}),
	};
}
