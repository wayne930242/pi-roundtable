import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	type Interaction,
	MessageFlags,
} from "discord.js";
import type { ConversationPort } from "../contract/channels.ts";
import { channelKey } from "../contract/surface.ts";
import { messages } from "../i18n/index.ts";
import type { CommandGuard, InteractionModule } from "./interaction-module.ts";

export const STOP_BUTTON_ID = "roundtable:stop";

/** The message a long turn shows: a stop button only the owner may press. */
export function stopPanel() {
	return {
		content: messages().stopNote,
		components: [
			new ActionRowBuilder<ButtonBuilder>().addComponents(
				new ButtonBuilder()
					.setCustomId(STOP_BUTTON_ID)
					.setLabel(messages().stopLabel)
					.setEmoji("⏹️")
					.setStyle(ButtonStyle.Danger),
			),
		],
	};
}

export interface StopButtonOptions {
	guard: Pick<CommandGuard, "isOwner">;
	/** Stops the running turn of the channel the button was pressed in, through its claim. */
	conversations: Pick<ConversationPort, "stop">;
}

/**
 * Answers a press of the stop button: only the owner stops the channel's turn, and the answer,
 * visible only to whoever pressed, says whether one was running.
 */
export function stopButtonModule(
	options: StopButtonOptions,
): InteractionModule {
	return {
		commands: () => [],
		handle: async (interaction: Interaction) => {
			if (!interaction.isButton() || interaction.customId !== STOP_BUTTON_ID)
				return false;
			const owner = options.guard.isOwner(interaction);
			const stopped =
				owner &&
				options.conversations.stop(
					channelKey("discord", interaction.channelId),
				);
			const text = messages();
			let content = text.stopIdle;
			if (!owner) content = text.stopOwnerOnly;
			else if (stopped) content = text.stopDone;
			await interaction.reply({ content, flags: MessageFlags.Ephemeral });
			return true;
		},
	};
}
