import { expect, test } from "bun:test";
import { inspect } from "node:util";
import { DiscordAPIError } from "discord.js";
import type { DiscordCard } from "./poster.ts";
import { cardBody, checkedWebhookCard } from "./poster-checks.ts";
import { DiscordPosterError } from "./poster-errors.ts";
import {
	type DiscordRest,
	type RestOptions,
	restPoster,
} from "./rest-poster.ts";

const CHANNEL = "900000000000000201";
const MESSAGE = "900000000000000202";
const BOT = "900000000000000204";
const HOOK = "900000000000000205";
const TOKEN = "card-hook-token-secret-value";

const PLAIN: DiscordCard = {
	accent: 0x336699,
	title: "Ticket",
	sections: ["first", "second"],
	footer: "quiet",
	buttons: [{ customId: "go:1", label: "Go", style: "primary" }],
	links: [{ label: "Open", url: "https://example.test/t/1" }],
};

const THUMB = { url: "https://img.example.test/t.png", description: "badge" };
const IMAGE = { url: "https://img.example.test/p.png", description: "panel" };

/** The container of a card body. */
function container(card: DiscordCard) {
	const [only] = cardBody(card).components;
	return only as { type: number; accent_color?: number; components: unknown[] };
}

test("a card without a thumbnail or image is the same body as before", () => {
	expect(cardBody(PLAIN)).toEqual({
		flags: 1 << 15,
		components: [
			{
				type: 17,
				accent_color: 0x336699,
				components: [
					{ type: 10, content: "### Ticket" },
					{ type: 14, divider: true, spacing: 1 },
					{ type: 10, content: "first" },
					{ type: 10, content: "second" },
					{ type: 10, content: "-# quiet" },
					{
						type: 1,
						components: [
							{ type: 2, style: 1, label: "Go", custom_id: "go:1" },
							{
								type: 2,
								style: 5,
								label: "Open",
								url: "https://example.test/t/1",
							},
						],
					},
				],
			},
		],
		allowed_mentions: { parse: [] },
	});
});

test("a thumbnail makes the heading a Section with a Thumbnail accessory", () => {
	expect(
		container({ ...PLAIN, thumbnail: THUMB }).components.slice(0, 4),
	).toEqual([
		{
			type: 9,
			components: [{ type: 10, content: "### Ticket" }],
			accessory: {
				type: 11,
				media: { url: "https://img.example.test/t.png" },
				description: "badge",
			},
		},
		{ type: 14, divider: true, spacing: 1 },
		{ type: 10, content: "first" },
		{ type: 10, content: "second" },
	]);
});

test("a thumbnail without a description sends none; a heading-only card still has no divider", () => {
	expect(
		container({
			title: "T",
			sections: [],
			thumbnail: { url: "https://img.example.test/t.png" },
		}).components,
	).toEqual([
		{
			type: 9,
			components: [{ type: 10, content: "### T" }],
			accessory: {
				type: 11,
				media: { url: "https://img.example.test/t.png" },
			},
		},
	]);
});

test("an image is a Media Gallery under the sections and above the quiet last line", () => {
	expect(container({ ...PLAIN, image: IMAGE }).components.slice(0, 6)).toEqual([
		{ type: 10, content: "### Ticket" },
		{ type: 14, divider: true, spacing: 1 },
		{ type: 10, content: "first" },
		{ type: 10, content: "second" },
		{
			type: 12,
			items: [
				{
					media: { url: "https://img.example.test/p.png" },
					description: "panel",
				},
			],
		},
		{ type: 10, content: "-# quiet" },
	]);
});

test("a thumbnail and an image together keep the colour bar and the buttons", () => {
	const body = container({ ...PLAIN, thumbnail: THUMB, image: IMAGE });
	expect(body.accent_color).toBe(0x336699);
	expect(
		body.components.map((part) => (part as { type: number }).type),
	).toEqual([9, 14, 10, 10, 12, 10, 1]);
});

test("a picture takes an https address of at most 2,048 characters and a description of 1 to 1,024", () => {
	const refused = [
		{ url: "http://img.example.test/t.png" },
		{ url: "attachment://t.png" },
		{ url: "not a url" },
		{ url: ` ${THUMB.url}` },
		{ url: `https://img.example.test/${"x".repeat(2_048)}` },
		{ url: THUMB.url, description: "" },
		{ url: THUMB.url, description: "x".repeat(1_025) },
	];
	for (const picture of refused) {
		expect(() => cardBody({ ...PLAIN, thumbnail: picture })).toThrow(
			DiscordPosterError,
		);
		expect(() => cardBody({ ...PLAIN, image: picture })).toThrow(
			DiscordPosterError,
		);
	}
	expect(() =>
		cardBody({
			...PLAIN,
			thumbnail: { url: THUMB.url, description: "x".repeat(1_024) },
		}),
	).not.toThrow();
});

test("a webhook card's body is the card with the name and picture, and no content", () => {
	const checked = checkedWebhookCard({
		webhook: "relay",
		username: " Ann ",
		avatarUrl: "https://img.example.test/a.png",
		card: PLAIN,
	});
	expect(checked.webhook).toBe("relay");
	expect(checked.body).toEqual({
		username: "Ann",
		avatar_url: "https://img.example.test/a.png",
		...cardBody(PLAIN),
	});
	expect("content" in checked.body).toBe(false);
	expect(
		"avatar_url" in
			checkedWebhookCard({
				webhook: "relay",
				username: "Ann",
				avatarUrl: "http://img.example.test/a.png",
				card: PLAIN,
			}).body,
	).toBe(false);
	for (const bad of [
		{ webhook: "my discord", username: "Ann" },
		{ webhook: "relay", username: "here" },
		{ webhook: "", username: "Ann" },
	])
		expect(() => checkedWebhookCard({ ...bad, card: PLAIN })).toThrow(
			DiscordPosterError,
		);
});

interface Sent {
	method: string;
	route: string;
	options: RestOptions | undefined;
}

/** A Discord that holds one webhook and records every call, with the options it was sent. */
function recorder(fail?: (call: Sent) => unknown) {
	const calls: Sent[] = [];
	const make =
		(method: string) => async (route: string, options?: RestOptions) => {
			const call = { method, route, options };
			calls.push(call);
			const thrown = fail?.(call);
			if (thrown instanceof Error) throw thrown;
			if (route === "/users/@me") return { id: BOT };
			if (route === `/channels/${CHANNEL}/webhooks`)
				return method === "GET"
					? [{ id: HOOK, token: TOKEN, name: "relay", user: { id: BOT } }]
					: { id: HOOK, token: TOKEN };
			return { id: MESSAGE };
		};
	const rest: DiscordRest = {
		get: make("GET"),
		post: make("POST"),
		patch: make("PATCH"),
		put: make("PUT"),
		delete: make("DELETE"),
	};
	return { rest, calls };
}

const WITH = new URLSearchParams({ wait: "true", with_components: "true" });

test("postCard executes the webhook with the card's Components V2 JSON and with_components", async () => {
	const { rest, calls } = recorder();
	const card = { ...PLAIN, thumbnail: THUMB, image: IMAGE };
	const posted = await restPoster(rest).postCard(CHANNEL, {
		webhook: "relay",
		username: "Ann",
		avatarUrl: "https://img.example.test/a.png",
		card,
	});
	expect(posted).toEqual({ channelId: CHANNEL, messageId: MESSAGE });
	const call = calls.find((entry) => entry.route.startsWith("/webhooks/"));
	expect(call?.method).toBe("POST");
	expect(call?.route).toBe(`/webhooks/${HOOK}/${TOKEN}`);
	expect(call?.options?.auth).toBe(false);
	expect(call?.options?.query?.toString()).toBe(WITH.toString());
	expect(call?.options?.body).toEqual({
		username: "Ann",
		avatar_url: "https://img.example.test/a.png",
		flags: 1 << 15,
		components: [
			{
				type: 17,
				accent_color: 0x336699,
				components: [
					{
						type: 9,
						components: [{ type: 10, content: "### Ticket" }],
						accessory: {
							type: 11,
							media: { url: "https://img.example.test/t.png" },
							description: "badge",
						},
					},
					{ type: 14, divider: true, spacing: 1 },
					{ type: 10, content: "first" },
					{ type: 10, content: "second" },
					{
						type: 12,
						items: [
							{
								media: { url: "https://img.example.test/p.png" },
								description: "panel",
							},
						],
					},
					{ type: 10, content: "-# quiet" },
					{
						type: 1,
						components: [
							{ type: 2, style: 1, label: "Go", custom_id: "go:1" },
							{
								type: 2,
								style: 5,
								label: "Open",
								url: "https://example.test/t/1",
							},
						],
					},
				],
			},
		],
		allowed_mentions: { parse: [] },
	});
});

test("editWebhookCard patches the webhook's message with the card and with_components, trying each name", async () => {
	const { rest, calls } = recorder();
	await restPoster(rest).editWebhookCard(
		CHANNEL,
		MESSAGE,
		{ ...PLAIN, image: IMAGE },
		["relay"],
	);
	const call = calls.find((entry) => entry.method === "PATCH");
	expect(call?.route).toBe(`/webhooks/${HOOK}/${TOKEN}/messages/${MESSAGE}`);
	expect(call?.options?.auth).toBe(false);
	expect(call?.options?.query?.toString()).toBe("with_components=true");
	expect(call?.options?.body).toEqual(cardBody({ ...PLAIN, image: IMAGE }));
	expect(call?.options?.body).not.toHaveProperty("username");
});

test("a failed card post or edit carries no webhook token, and the poster shows none", async () => {
	const rejected = new DiscordAPIError(
		{ code: 50035, message: "said so" },
		50035,
		400,
		"POST",
		`https://discord.test/api/v10/webhooks/${HOOK}/${TOKEN}`,
		{},
	);
	const { rest } = recorder((call) =>
		call.route.startsWith("/webhooks/") ? rejected : undefined,
	);
	const poster = restPoster(rest);
	for (const run of [
		() =>
			poster.postCard(CHANNEL, {
				webhook: "relay",
				username: "Ann",
				card: PLAIN,
			}),
		() => poster.editWebhookCard(CHANNEL, MESSAGE, PLAIN, ["relay"]),
	]) {
		const error = await run().then(
			() => undefined,
			(thrown: unknown) => thrown,
		);
		expect(error).toBeInstanceOf(DiscordPosterError);
		expect(inspect(error, { depth: 6 })).not.toContain(TOKEN);
	}
	expect(inspect(poster, { depth: 6 })).not.toContain(TOKEN);
});
