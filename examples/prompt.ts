import { definePlugin } from "pi-roundtable";

/** A prompt section is text added after the core's prompt in every agent turn; return undefined to add nothing. */
export const houseRules = definePlugin({
	name: "house-rules",
	setup: () => ({
		prompt: [
			{
				name: "house-rules",
				build: ({ agent, speaker }) =>
					[
						`House rules for ${agent.displayName}: answer in the language you were asked in.`,
						speaker ? `You are talking with ${speaker.name}.` : undefined,
					]
						.filter((line) => line !== undefined)
						.join(" "),
			},
		],
	}),
});
