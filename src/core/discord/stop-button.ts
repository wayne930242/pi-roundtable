import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import { messages } from "../i18n/index.ts";

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
