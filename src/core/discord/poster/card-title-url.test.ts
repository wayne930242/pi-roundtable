import { expect, test } from "bun:test";
import { DiscordAPIError } from "discord.js";
import type { DiscordCard } from "./poster.ts";
import { cardBody } from "./poster-checks.ts";
import { DiscordPosterError } from "./poster-errors.ts";
import {
	type DiscordRest,
	type RestOptions,
	restPoster,
} from "./rest-poster.ts";

const CHANNEL = "900000000000000401";
const MESSAGE = "900000000000000402";
const HOOK = "900000000000000405";
const TOKEN = "title-hook-token-secret-value";

const CARD: DiscordCard = {
	accent: 0x336699,
	title: "Ticket",
	sections: ["first"],
	footer: "quiet",
};

type V2Body = {
	components: {
		components: { type: number; content?: string; components?: unknown[] }[];
	}[];
};

/** The heading of a Components V2 card body: its first text. */
function heading(card: DiscordCard): string | undefined {
	const first = (cardBody(card) as unknown as V2Body).components[0]
		?.components[0];
	if (first?.type !== 9) return first?.content;
	const [text] = (first.components ?? []) as { content?: string }[];
	return text?.content;
}

test("without titleUrl a Components V2 heading and a preview embed are exactly what they were", () => {
	expect(heading(CARD)).toBe("### Ticket");
	expect(cardBody({ ...CARD, preview: "p" })).toEqual({
		content: "p",
		embeds: [
			{
				title: "Ticket",
				description: "first",
				color: 0x336699,
				footer: { text: "quiet" },
			},
		],
		components: [],
		allowed_mentions: { parse: [] },
	});
});

test("titleUrl is the embed url of a preview card, and the title stays plain text", () => {
	const body = cardBody({
		...CARD,
		preview: "p",
		titleUrl: "https://example.test/t/1",
	}) as { embeds: Record<string, unknown>[] };
	expect(body.embeds[0]).toMatchObject({
		title: "Ticket",
		url: "https://example.test/t/1",
	});
});

test("titleUrl is a masked link in the Components V2 heading, with a thumbnail too", () => {
	const url = "https://example.test/t/1";
	expect(heading({ ...CARD, titleUrl: url })).toBe(`### [Ticket](${url})`);
	expect(
		heading({
			...CARD,
			titleUrl: url,
			thumbnail: { url: "https://img.example.test/t.png" },
		}),
	).toBe(`### [Ticket](${url})`);
});

test("the title is escaped as a link label: backslash and brackets only", () => {
	expect(
		heading({
			...CARD,
			title: "A [1] \\ **b**",
			titleUrl: "https://example.test/t",
		}),
	).toBe("### [A \\[1\\] \\\\ **b**](https://example.test/t)");
});

test("a non-ASCII address is percent-encoded, and parentheses cannot end the link", () => {
	const encoded = "https://example.test/%E6%A1%88%E4%BB%B6/1?q=%28a%29";
	const url = "https://example.test/案件/1?q=(a)";
	expect(heading({ ...CARD, titleUrl: url })).toBe(`### [Ticket](${encoded})`);
	const body = cardBody({ ...CARD, preview: "p", titleUrl: url }) as {
		embeds: { url?: string }[];
	};
	expect(body.embeds[0]?.url).toBe(encoded);
	// A host in Unicode is sent as punycode; an address that is already encoded is not encoded twice.
	expect(heading({ ...CARD, titleUrl: "https://例え.test/a%20b" })).toBe(
		"### [Ticket](https://xn--r8jz45g.test/a%20b)",
	);
});

test("an address that is not absolute http(s) is refused as invalid, for both kinds", () => {
	for (const bad of [
		"",
		"/relative",
		"example.test/t",
		"javascript:alert(1)",
		"data:text/html,x",
		"ftp://example.test/t",
		" https://example.test/t",
		"https://example.test/t ",
		"https://exa mple.test/t",
		`https://example.test/${"a".repeat(2_048)}`,
	])
		for (const extra of [{}, { preview: "p" }]) {
			const error = (() => {
				try {
					cardBody({ ...CARD, ...extra, titleUrl: bad });
				} catch (thrown) {
					return thrown;
				}
			})();
			expect(error).toBeInstanceOf(DiscordPosterError);
			expect((error as DiscordPosterError).kind).toBe("invalid");
		}
	expect(() =>
		cardBody({
			...CARD,
			titleUrl: `https://example.test/${"a".repeat(2_000)}`,
		}),
	).not.toThrow();
});

interface Sent {
	method: string;
	route: string;
	options?: RestOptions;
}

/** A Discord that records every request and refuses the first edit of a message with a legacy body (it holds a Components V2 card). */
function v2Discord(): DiscordRest & { sent: Sent[] } {
	const sent: Sent[] = [];
	const make =
		(method: string) => async (route: string, options?: RestOptions) => {
			sent.push({ method, route, ...(options ? { options } : {}) });
			if (route === "/users/@me") return { id: "990000000000000004" };
			if (route === `/channels/${CHANNEL}/webhooks`)
				return method === "GET"
					? [
							{
								id: HOOK,
								token: TOKEN,
								name: "relay",
								user: { id: "990000000000000004" },
							},
						]
					: { id: HOOK, token: TOKEN };
			const body = options?.body as Record<string, unknown> | undefined;
			if (method === "PATCH" && body && "embeds" in body)
				throw new DiscordAPIError(
					{ code: 50035, message: "legacy fields on Components V2" },
					50035,
					400,
					method,
					`https://discord.test/api/v10${route}`,
					{},
				);
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

const bodiesOf = (sent: Sent[]) =>
	sent
		.filter((call) => call.method === "PATCH")
		.map((call) => call.options?.body as Record<string, unknown>);

test("editCard of a Components V2 message with a preview is sent again as Components V2 without the preview", async () => {
	const rest = v2Discord();
	const poster = restPoster(rest);
	await poster.editCard(CHANNEL, MESSAGE, {
		...CARD,
		preview: "p",
		titleUrl: "https://example.test/t",
	});
	const [first, second] = bodiesOf(rest.sent);
	expect(first).toMatchObject({ content: "p" });
	expect(second).toMatchObject({ flags: 1 << 15 });
	expect(second).not.toHaveProperty("content");
	expect(JSON.stringify(second)).toContain(
		"### [Ticket](https://example.test/t)",
	);
	expect(bodiesOf(rest.sent)).toHaveLength(2);
});

test("editWebhookCard falls back the same way, and a card without a preview is not sent twice", async () => {
	const rest = v2Discord();
	const poster = restPoster(rest);
	await poster.editWebhookCard(CHANNEL, MESSAGE, { ...CARD, preview: "p" }, [
		"relay",
	]);
	const bodies = bodiesOf(rest.sent);
	expect(bodies).toHaveLength(2);
	expect(bodies[1]).toMatchObject({ flags: 1 << 15 });
	// Without a preview nothing is retried: the error is the caller's.
	const failing = restPoster({
		...rest,
		patch: async () => {
			throw new DiscordAPIError(
				{ code: 50035, message: "no" },
				50035,
				400,
				"PATCH",
				"https://discord.test/api/v10/x",
				{},
			);
		},
	});
	await expect(failing.editCard(CHANNEL, MESSAGE, CARD)).rejects.toBeInstanceOf(
		DiscordPosterError,
	);
});

test("when the Components V2 retry fails too, the first error is the one thrown", async () => {
	let calls = 0;
	const rest = v2Discord();
	const poster = restPoster({
		...rest,
		patch: async () => {
			calls += 1;
			throw new DiscordAPIError(
				{ code: 50035, message: `refusal ${calls}` },
				50035,
				400,
				"PATCH",
				"https://discord.test/api/v10/x",
				{},
			);
		},
	});
	const error = await poster
		.editCard(CHANNEL, MESSAGE, { ...CARD, preview: "p" })
		.catch((thrown: unknown) => thrown);
	expect(calls).toBe(2);
	expect((error as DiscordPosterError).kind).toBe("rejected");
	expect((error as DiscordPosterError).message).toContain("refusal 1");
});
