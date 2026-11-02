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
};

const PREVIEW: DiscordCard = {
	...CARD,
	preview: "Ticket 1 needs a look",
	thumbnail: { url: "https://img.example.test/t.png", description: "t" },
};

/** The scenarios of a card's title link. */
export const titleScenarios: Scenario[] = [
	{
		name: "24. a card's titleUrl is the embed's url on a preview card and a masked link in a Components V2 heading; it is checked before any request",
		async run({ poster, world }) {
			const ch = freshId();
			world.channel(ch);
			const url = "https://example.test/café/1?q=(a)";
			const encoded = "https://example.test/caf%C3%A9/1?q=%28a%29";
			const legacy = await poster.sayCard(ch, { ...PREVIEW, titleUrl: url });
			expect(world.legacyCard(ch, legacy.messageId)).toMatchObject({
				title: "Ticket",
				url: encoded,
			});
			const v2 = await poster.sayCard(ch, {
				...CARD,
				title: "Ticket [1]",
				titleUrl: url,
			});
			expect(world.cardHeading(ch, v2.messageId)).toBe(
				`### [Ticket \\[1\\]](${encoded})`,
			);
			// The thumbnail's section holds the heading too.
			const withThumb = await poster.sayCard(ch, {
				...CARD,
				thumbnail: PREVIEW.thumbnail,
				titleUrl: "http://example.test/t",
			});
			expect(world.cardHeading(ch, withThumb.messageId)).toBe(
				"### [Ticket](http://example.test/t)",
			);
			// An edit sets or drops the link.
			await poster.editCard(ch, legacy.messageId, PREVIEW);
			expect(world.legacyCard(ch, legacy.messageId)?.url).toBeUndefined();
			await poster.editCard(ch, v2.messageId, CARD);
			expect(world.cardHeading(ch, v2.messageId)).toBe("### Ticket");
			// Anything but an absolute http(s) address is refused before a request.
			const before = world.requests();
			for (const bad of [
				"",
				"/relative",
				"example.test/t",
				"javascript:alert(1)",
				"ftp://example.test/t",
				" https://example.test/t",
				"https://exa mple.test/t",
				`https://example.test/${"a".repeat(2_048)}`,
			]) {
				await expectFailure(
					poster.sayCard(ch, { ...PREVIEW, titleUrl: bad }),
					"invalid",
				);
				await expectFailure(
					poster.sayCard(ch, { ...CARD, titleUrl: bad }),
					"invalid",
				);
			}
			expect(world.requests()).toBe(before);
		},
	},
];
