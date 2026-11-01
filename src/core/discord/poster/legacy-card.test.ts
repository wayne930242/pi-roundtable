import { expect, test } from "bun:test";
import type { DiscordCard } from "./poster.ts";
import { cardBody, checkedWebhookCard } from "./poster-checks.ts";
import { DiscordPosterError } from "./poster-errors.ts";
import {
	type DiscordRest,
	type RestOptions,
	restPoster,
} from "./rest-poster.ts";

const CHANNEL = "900000000000000301";
const MESSAGE = "900000000000000302";
const BOT = "900000000000000304";
const HOOK = "900000000000000305";
const TOKEN = "legacy-hook-token-secret-value";

const CARD: DiscordCard = {
	accent: 0x336699,
	title: "Ticket",
	sections: ["first", "", "second"],
	footer: "quiet",
	preview: "Ticket 1\nneeds   a look",
	thumbnail: { url: "https://img.example.test/t.png", description: "badge" },
	image: { url: "https://img.example.test/p.png", description: "panel" },
	buttons: [{ customId: "go:1", label: "Go", style: "primary" }],
	links: [{ label: "Open", url: "https://example.test/t/1" }],
	selects: [
		{
			customId: "pick:1",
			placeholder: "State",
			options: [{ label: "Open", value: "open", selected: true }],
		},
	],
};

test("a card with a preview is a legacy body: content, one embed and top-level action rows, with no Components V2 flag", () => {
	expect(cardBody(CARD)).toEqual({
		content: "Ticket 1 needs a look",
		embeds: [
			{
				title: "Ticket",
				description: "first\n\nsecond",
				color: 0x336699,
				footer: { text: "quiet" },
				thumbnail: { url: "https://img.example.test/t.png" },
				image: { url: "https://img.example.test/p.png" },
			},
		],
		components: [
			{
				type: 1,
				components: [
					{
						type: 3,
						custom_id: "pick:1",
						placeholder: "State",
						min_values: 1,
						max_values: 1,
						options: [{ label: "Open", value: "open", default: true }],
					},
				],
			},
			{
				type: 1,
				components: [
					{ type: 2, style: 1, label: "Go", custom_id: "go:1" },
					{ type: 2, style: 5, label: "Open", url: "https://example.test/t/1" },
				],
			},
		],
		allowed_mentions: { parse: [] },
	});
});

test("a bare preview card is a title in an embed with no rows, no colour and no description", () => {
	expect(cardBody({ title: "T", sections: [], preview: "p" })).toEqual({
		content: "p",
		embeds: [{ title: "T" }],
		components: [],
		allowed_mentions: { parse: [] },
	});
});

test("a card without a preview is still Components V2, sharing its rows with the legacy form", () => {
	const { preview: _, ...v2 } = CARD;
	const body = cardBody(v2) as {
		flags?: number;
		components: { components: unknown[] }[];
	};
	expect(body.flags).toBe(1 << 15);
	expect(body).not.toHaveProperty("content");
	expect(body).not.toHaveProperty("embeds");
	const legacy = cardBody(CARD);
	expect(body.components[0]?.components.slice(-2)).toEqual(
		(legacy as { components: unknown[] }).components,
	);
});

test("a preview is refused when it is empty after flattening, too long, or on a card too large for an embed", () => {
	const refuse = (card: DiscordCard) => {
		const thrown = (() => {
			try {
				cardBody(card);
			} catch (error) {
				return error;
			}
		})();
		expect(thrown).toBeInstanceOf(DiscordPosterError);
		expect((thrown as DiscordPosterError).kind).toBe("invalid");
	};
	refuse({ ...CARD, preview: "" });
	refuse({ ...CARD, preview: "\n \t" });
	refuse({ ...CARD, preview: "x".repeat(2_001) });
	refuse({ ...CARD, title: "t".repeat(257) });
	refuse({ ...CARD, sections: ["x".repeat(3_800)] });
	refuse({
		...CARD,
		selects: Array.from({ length: 5 }, (_, i) => ({
			customId: `pick:${i}`,
			placeholder: "State",
			options: [{ label: "Open", value: "open" }],
		})),
	});
	expect(() => cardBody({ ...CARD, preview: "x".repeat(2_000) })).not.toThrow();
});

test("a webhook's card post carries the preview body under its name and picture", () => {
	const { webhook, body } = checkedWebhookCard({
		webhook: "relay",
		username: "Ann",
		avatarUrl: "https://img.example.test/a.png",
		card: CARD,
	});
	expect(webhook).toBe("relay");
	expect(body).toMatchObject({
		username: "Ann",
		avatar_url: "https://img.example.test/a.png",
		content: "Ticket 1 needs a look",
	});
	expect(body).not.toHaveProperty("flags");
});

interface Sent {
	method: string;
	route: string;
	options?: RestOptions;
}

/** A Discord that records every request and answers a message. */
function recordingRest(): DiscordRest & { sent: Sent[] } {
	const sent: Sent[] = [];
	const make =
		(method: string) => async (route: string, options?: RestOptions) => {
			sent.push({ method, route, ...(options ? { options } : {}) });
			if (route === "/users/@me") return { id: BOT };
			if (route === `/channels/${CHANNEL}/webhooks`)
				return method === "GET"
					? [{ id: HOOK, token: TOKEN, name: "relay", user: { id: BOT } }]
					: { id: HOOK, token: TOKEN };
			return { id: MESSAGE };
		};
	return {
		sent,
		get: make("GET"),
		post: make("POST"),
		patch: make("PATCH"),
		put: make("PUT"),
		delete: make("DELETE"),
	};
}

test("sayCard, editCard, postCard and editWebhookCard send the legacy body, and an edit sets the content too", async () => {
	const rest = recordingRest();
	const poster = restPoster(rest);
	await poster.sayCard(CHANNEL, CARD);
	await poster.editCard(CHANNEL, MESSAGE, { ...CARD, preview: "changed" });
	await poster.postCard(CHANNEL, {
		webhook: "relay",
		username: "Ann",
		card: CARD,
	});
	await poster.editWebhookCard(
		CHANNEL,
		MESSAGE,
		{ ...CARD, preview: "again", buttons: [], links: [], selects: [] },
		["relay"],
	);
	const requests = rest.sent.filter(
		(call) => call.method === "POST" || call.method === "PATCH",
	);
	const bodies = requests
		.filter((call) => call.options?.body !== undefined)
		.map((call) => call.options?.body as Record<string, unknown>)
		.filter((body) => "embeds" in body);
	expect(bodies.map((body) => body.content)).toEqual([
		"Ticket 1 needs a look",
		"changed",
		"Ticket 1 needs a look",
		"again",
	]);
	for (const body of bodies) {
		expect(body).not.toHaveProperty("flags");
		expect(body.embeds).toHaveLength(1);
	}
	// An edit that drops the buttons sends an empty list, so Discord removes them.
	expect(bodies[3]?.components).toEqual([]);
	// The webhook calls ask for components, as a card's do.
	const hooked = requests.filter((call) => call.route.startsWith("/webhooks/"));
	expect(hooked).toHaveLength(2);
	for (const call of hooked)
		expect(call.options?.query?.get("with_components")).toBe("true");
});
