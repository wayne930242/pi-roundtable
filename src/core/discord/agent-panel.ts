import { type Interaction, MessageFlags } from "discord.js";
import type { AgentServer, SkillRegistry } from "../services.ts";
import {
	AGENT_BUTTON_PREFIX,
	AGENT_MODAL_PREFIX,
	AgentCommands,
	type AgentPanelMessage,
} from "./agent-commands.ts";
import type { CommandGuard } from "./interaction-module.ts";

export interface AgentPanelOptions {
	/** Who may press the panel's buttons and submit its forms. */
	guard: CommandGuard;
	/** The agent server whose agents the panel shows and edits. */
	agents: AgentServer;
	/** The skills an agent carries, listed in the panel; without it the panel lists none. */
	skills?: Pick<SkillRegistry, "carried">;
}

/** An agent's panel: its prompt, picture, model, and skills, with buttons and forms to change them. */
export interface AgentPanel {
	/**
	 * The panel of the agent whose channel this is. Throws OwnerFacingError, which a command run
	 * through the guard answers as a panel, when the channel belongs to no agent.
	 */
	open(channelId: string): AgentPanelMessage;
	/**
	 * Answers the panel's own buttons and form, for the owner only and deferred as Discord needs;
	 * true when it handled the interaction. The custom ids are fixed, so panels already posted keep working.
	 */
	handles(interaction: Interaction): Promise<boolean>;
}

/** Builds the agent panel of `/<root> profile`; the caller adds the subcommand and routes the panel's components here. */
export function agentPanel(options: AgentPanelOptions): AgentPanel {
	const { guard, agents } = options;
	const commands = new AgentCommands({
		store: agents.directory,
		team: agents.team,
		studio: agents.avatars,
		...(options.skills ? { skills: options.skills } : {}),
	});
	return {
		open: (channelId) => commands.panel(channelId),
		async handles(interaction) {
			if (
				interaction.isButton() &&
				interaction.customId.startsWith(AGENT_BUTTON_PREFIX)
			) {
				if (!(await guard.allows(interaction))) return true;
				await guard.run(interaction, () => commands.button(interaction));
				return true;
			}
			if (
				interaction.isModalSubmit() &&
				interaction.customId.startsWith(AGENT_MODAL_PREFIX)
			) {
				if (!(await guard.allows(interaction))) return true;
				await interaction.deferReply({ flags: MessageFlags.Ephemeral });
				await guard.run(interaction, () => commands.submit(interaction));
				return true;
			}
			return false;
		},
	};
}
