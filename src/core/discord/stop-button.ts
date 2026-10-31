import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	type Interaction,
	type Message,
	MessageFlags,
	type SendableChannels,
} from "discord.js";
import type { ConversationPort } from "../contract/channels.ts";
import { channelKey } from "../contract/surface.ts";
import { messages } from "../i18n/index.ts";
import type { CommandGuard, InteractionModule } from "./interaction-module.ts";

export const STOP_BUTTON_ID = "roundtable:stop";
/** A turn shorter than this shows no stop button, so quick answers do not flicker one. */
const STOP_PANEL_DELAY_MS = 5_000;

/** The message a long turn shows: a stop button only an owner may press. */
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

/**
 * Shows the stop panel in the channel `sendable` finds once the turn has run for
 * `STOP_PANEL_DELAY_MS`; the returned function hides it, or keeps it from showing. A failure is
 * handed to `warn` with what failed, never thrown.
 */
export function showStopPanel(
	sendable: () => Promise<SendableChannels>,
	warn: (error: unknown, what: string) => void,
): () => void {
	let hidden = false;
	let panel: Message | undefined;
	const remove = (message: Message) =>
		message
			.delete()
			.catch((error: unknown) => warn(error, "stop panel not removed"));
	const timer = setTimeout(() => {
		sendable()
			.then((target): Promise<Message> => target.send(stopPanel()))
			.then((message) => {
				if (hidden) void remove(message);
				else panel = message;
			})
			.catch((error: unknown) => warn(error, "stop panel not shown"));
	}, STOP_PANEL_DELAY_MS);
	return () => {
		hidden = true;
		clearTimeout(timer);
		if (panel) void remove(panel);
	};
}

export interface StopButtonOptions {
	guard: Pick<CommandGuard, "allows">;
	/** Stops the running turn of the channel the button was pressed in, through its claim. */
	conversations: Pick<ConversationPort, "stop">;
}

/**
 * Answers a press of the stop button: only an owner stops the channel's turn, and the answer,
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
			const owner = await options.guard.allows(interaction);
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
