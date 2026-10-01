import type {
	SlashCommandStringOption,
	SlashCommandSubcommandGroupBuilder,
} from "discord.js";
import {
	type CommandGuard,
	groupOption,
	type InteractionContribution,
	ownerCommandModule,
} from "pi-roundtable/discord";
import type { ChannelGrantStore } from "./channel-grants.ts";
import { McpGrantFlow } from "./mcp-grant-flow.ts";
import { GRANT_PREFIX } from "./mcp-grant-panels.ts";
import type { RemoteMcpMessages } from "./messages.ts";

function mcpGroup(text: RemoteMcpMessages) {
	const bundle = (option: SlashCommandStringOption) =>
		option
			.setName("bundle")
			.setDescription(text.bundleOption)
			.setMaxLength(80)
			.setAutocomplete(true)
			.setRequired(true);
	const agentName =
		(description: string) => (option: SlashCommandStringOption) =>
			option.setName("name").setDescription(description).setMaxLength(100);
	const purpose = (option: SlashCommandStringOption) =>
		option
			.setName("description")
			.setDescription(text.purposeOption)
			.setMaxLength(1000);
	const channelId = (option: SlashCommandStringOption) =>
		option.setName("channel_id").setDescription(text.channelIdOption);
	return (group: SlashCommandSubcommandGroupBuilder) =>
		group
			.setName("mcp")
			.setDescription(text.groupDescription)
			.addSubcommand((sub) =>
				sub
					.setName("authorize")
					.setDescription(text.authorizeDescription)
					.addStringOption(bundle)
					.addStringOption(agentName(text.agentNameOption))
					.addStringOption(purpose),
			)
			.addSubcommand((sub) =>
				sub.setName("grants").setDescription(text.grantsDescription),
			)
			.addSubcommand((sub) =>
				sub
					.setName("revoke")
					.setDescription(text.revokeDescription)
					.addStringOption(bundle)
					.addStringOption(channelId),
			)
			.addSubcommand((sub) =>
				sub
					.setName("describe")
					.setDescription(text.describeDescription)
					.addStringOption(bundle)
					.addStringOption(agentName(text.describeAgentNameOption))
					.addStringOption(purpose)
					.addStringOption(channelId),
			)
			.addSubcommand((sub) =>
				sub
					.setName("token")
					.setDescription(text.tokenDescription)
					.addStringOption(bundle),
			);
}

/** `/<root> mcp …` and the buttons and menus its answers post. */
export function mcpGrantCommands(
	guard: CommandGuard,
	grants: ChannelGrantStore,
	publicUrl: string,
	text: RemoteMcpMessages,
): InteractionContribution {
	const flow = new McpGrantFlow(grants, publicUrl, guard.root, text);
	return {
		module: ownerCommandModule(guard, {
			owns: (group) => group === "mcp",
			autocomplete: (interaction) => flow.autocomplete(interaction),
			command: (interaction) => flow.command(interaction),
			component: async (interaction) => {
				if (
					!(interaction.isButton() || interaction.isStringSelectMenu()) ||
					!interaction.customId.startsWith(GRANT_PREFIX)
				)
					return false;
				await guard.run(interaction, () => flow.component(interaction));
				return true;
			},
		}),
		rootOptions: [groupOption(mcpGroup(text))],
	};
}
