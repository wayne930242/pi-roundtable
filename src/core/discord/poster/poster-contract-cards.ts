import { expect } from "bun:test";
import type { DiscordCard } from "./poster.ts";
import {
	expectFailure,
	freshId,
	type Scenario,
} from "./poster-contract-support.ts";

const CARD: DiscordCard = {
	accent: 0x336699,
	title: "Ticket",
	sections: ["first", "second"],
	footer: "quiet",
	buttons: [{ customId: "go:1", label: "Go", style: "primary" }],
	links: [{ label: "Open", url: "https://example.test/t/1" }],
};

/** The scenarios of cards with pictures and of cards a webhook posts. */
export const cardScenarios: Scenario[] = [
	{
		name: "15. a webhook posts and edits a card with a thumbnail and an image; its name and the other webhooks' limits hold",
		async run({ poster, world }) {
			const ch = freshId();
			world.channel(ch);
			const card: DiscordCard = {
				...CARD,
				thumbnail: { url: "https://img.example.test/t.png", description: "t" },
				image: { url: "https://img.example.test/p.png" },
			};
			const posted = await poster.postCard(ch, {
				webhook: "relay",
				username: "Ann",
				avatarUrl: "https://img.example.test/a.png",
				card,
			});
			const ids = await poster.webhookIds(ch, ["relay"]);
			const read = await poster.message(ch, posted.messageId);
			expect(world.isCard(ch, posted.messageId)).toBe(true);
			expect(read.webhookId).toBe(ids.relay?.[0]);
			await poster.editWebhookCard(
				ch,
				posted.messageId,
				{ ...card, title: "2" },
				["other", "relay"],
			);
			expect(world.isCard(ch, posted.messageId)).toBe(true);
			await expectFailure(
				poster.editWebhookCard(ch, posted.messageId, card, ["other"]),
				"message_gone",
			);
			const plain = await poster.post(ch, {
				webhook: "relay",
				username: "Ann",
				content: "plain",
			});
			await expectFailure(
				poster.editWebhookCard(ch, plain.messageId, card, ["relay"]),
				"rejected",
			);
			await expectFailure(
				poster.postCard(ch, {
					webhook: "relay",
					username: "Ann",
					card: { ...card, image: { url: "http://img.example.test/p.png" } },
				}),
				"invalid",
			);
			await poster.remove(ch, posted.messageId, ["relay"]);
		},
	},
];
