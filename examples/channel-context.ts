import { definePlugin, parseChannelKey } from "pi-roundtable";
import { DISCORD, withChannelContext } from "pi-roundtable/discord";

/** The kind of the tavern's conversations. */
const TAVERN = "tavern";

/**
 * A claim that opts in to channel context: in the Discord channels it owns it answers only the
 * messages that mention the assistant or reply to it, and each turn also reads what the others
 * said there since the assistant last posted. The context is public channel text appended to the
 * turn's text; the people who wrote it do not become speakers.
 */
export function tavern(channelIds: readonly string[]) {
	return definePlugin({
		name: "tavern",
		setup: ({ turns, services }) => {
			const discord = services.get(DISCORD);
			return {
				personas: [
					{
						kind: TAVERN,
						prompt: () =>
							"You keep the tavern's table. Answer the person who addressed you.",
					},
				],
				channels: [
					{
						name: "tavern",
						priority: 10,
						owns: (channel) => {
							const { surface, id } = parseChannelKey(channel);
							return surface === "discord" && channelIds.includes(id);
						},
						admit: (message) => {
							const { speaker } = message;
							if (message.authorIsBot || !speaker) return undefined;
							if (!message.mentionsBot && !message.repliesToBot)
								return undefined;
							return {
								kind: "turn",
								run: async () => {
									// Once per answered message, inside `run`: what it returns is not returned again.
									const around = await discord.channelContext(message, {
										keep: 20,
									});
									await turns.run({
										channel: message.channel,
										kind: TAVERN,
										text: withChannelContext(message.text, around),
										speaker,
									});
								},
								failure: "a tavern turn failed",
							};
						},
						startFresh: async () => TAVERN,
					},
				],
			};
		},
	});
}
