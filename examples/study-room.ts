import { definePlugin, parseChannelKey } from "pi-roundtable";

/** The kind of a study room's conversations: the string `startFresh` returns, and the persona's kind. */
const STUDY = "study";

/**
 * A conversation kind of its own. The persona is the system prompt of every `study` conversation,
 * the claim owns the channels of the study rooms, and `context.turns` runs each message as a turn
 * of that kind on whatever runtime the host has, and posts the answer through the channel's
 * surface.
 */
export const studyRoom = definePlugin({
	name: "study-room",
	setup: ({ turns }) => ({
		personas: [
			{
				kind: STUDY,
				prompt: () =>
					"You are a patient tutor. Ask one question back before you give the answer.",
			},
		],
		channels: [
			{
				name: "study-rooms",
				priority: 10,
				// The id of a room starts with `study-`, on whichever surface carries it.
				owns: (channel) => parseChannelKey(channel).id.startsWith("study-"),
				admit: (message) => {
					const speaker = message.speaker;
					if (message.authorIsBot || !speaker) return undefined;
					return {
						kind: "turn",
						run: async () => {
							await turns.run({
								channel: message.channel,
								kind: STUDY,
								text: message.text,
								speaker,
							});
						},
						failure: "a study turn failed",
					};
				},
				// What the conversation was, so a host picks the right persona when it starts over.
				startFresh: async () => STUDY,
			},
		],
	}),
});
