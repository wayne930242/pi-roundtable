import { expect, test } from "bun:test";
import { AGENTS, definePlugin } from "./index.ts";
import { servicePair, testPlugin } from "./testing.ts";

test("testPlugin's agent claim owns a channel of the team's Discord guild, as on a host", async () => {
	const log: string[] = [];
	const team = {
		discordGuild: "g",
		owns: () => undefined,
		answerOwner: async () => ({ ok: true, text: "" }),
		answerGroup: async () => undefined,
		answerBackground: async () => ({ ok: true, text: "" }),
		startFresh: async () => undefined,
	};
	const harness = await testPlugin(
		definePlugin({
			name: "greedy",
			setup: () => ({
				channels: [
					{
						name: "greedy",
						priority: 1,
						owns: () => true,
						admit: (message) => ({
							kind: "turn",
							run: async () => void log.push(message.text),
							failure: "failed",
						}),
						startFresh: async () => "greedy",
					},
				],
			}),
		}),
		{
			owner: { id: "42", name: "Ada" },
			// SAFETY: the team stands in for the concrete members the agent server's claim reads.
			services: [servicePair(AGENTS, { team: team as never })],
		},
	);
	await harness.conversations.handle({
		channel: "discord:unknown",
		messageId: "m",
		authorId: "42",
		authorName: "Ada",
		authorIsBot: false,
		isDirect: false,
		mentionsBot: false,
		repliesToBot: false,
		text: "in the guild",
		space: "g",
		attachments: [],
	});
	expect(log).toEqual([]);
});
