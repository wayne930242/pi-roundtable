import { expect, test } from "bun:test";
import { MessageReferenceType } from "discord.js";
import { withReference } from "../routing/message-text.ts";
import { toInbound } from "./inbound-message.ts";

const BOT = "900";
const identity = { botId: BOT, applicationId: "app-1" };
const OWNER_IDENTITY = {
	name: "Ada",
	pronouns: { subject: "they", object: "them", possessive: "their" },
};

const attachments = (...names: string[]) =>
	new Map(
		names.map((name) => [
			name,
			{ url: `https://files/${name}`, name, contentType: null, size: 1 },
		]),
	);

/** The parts of a discord.js Message that `toInbound` reads. */
function discordMessage(extra: Record<string, unknown> = {}) {
	return {
		id: "m1",
		channelId: "77",
		guildId: "g1",
		content: `<@${BOT}> hello`,
		author: { id: "1", bot: false, username: "ada", globalName: "Ada" },
		member: { displayName: "Ada N", roles: { cache: new Map([["r1", {}]]) } },
		webhookId: null,
		applicationId: null,
		reference: null,
		messageSnapshots: { first: () => undefined },
		mentions: { users: new Map([[BOT, {}]]) },
		channel: { isDMBased: () => false },
		attachments: attachments(),
		embeds: [],
		...extra,
	} as never;
}

test("a guild message reports its space, channel key, roles and mention, with the bot mention removed", async () => {
	expect(await toInbound(discordMessage(), identity)).toEqual({
		channel: "discord:77",
		messageId: "m1",
		actor: {
			provider: "discord",
			subject: "1",
			name: "Ada N",
			surface: "discord",
			roles: ["discord:role:r1"],
			space: "g1",
			legacyId: "1",
		},
		authorId: "1",
		authorName: "Ada N",
		authorIsBot: false,
		authorRoleIds: ["r1"],
		isDirect: false,
		space: "g1",
		mentionsBot: true,
		repliesToBot: false,
		text: "hello",
		attachments: [],
	});
});

test("a direct message has no space, and the bot's own or an unready client's messages are not reported", async () => {
	const direct = await toInbound(
		discordMessage({
			guildId: null,
			member: null,
			channel: { isDMBased: () => true },
		}),
		identity,
	);
	expect(direct?.isDirect).toBe(true);
	expect(direct).not.toHaveProperty("space");
	expect(direct).not.toHaveProperty("authorRoleIds");
	// A DM has no member: the author's roles are unknown, not none.
	expect(direct?.actor).toEqual({
		provider: "discord",
		subject: "1",
		name: "Ada",
		surface: "discord",
		legacyId: "1",
	});
	expect(
		await toInbound(
			discordMessage({ author: { id: BOT, bot: true, username: "b" } }),
			identity,
		),
	).toBeUndefined();
	expect(
		await toInbound(discordMessage(), { ...identity, botId: undefined }),
	).toBeUndefined();
});

test("a webhook's post is an integration, and it is the assistant's own when the application is", async () => {
	const posted = (applicationId: string | null) =>
		toInbound(discordMessage({ webhookId: "hook-1", applicationId }), identity);
	expect((await posted("app-1"))?.integration).toEqual({
		id: "hook-1",
		own: true,
	});
	expect((await posted("other"))?.integration).toEqual({
		id: "hook-1",
		own: false,
	});
	expect((await posted(null))?.integration).toEqual({
		id: "hook-1",
		own: false,
	});
	expect(await toInbound(discordMessage(), identity)).not.toHaveProperty(
		"integration",
	);
});

test("a forward reports the channel it came from as a key, and the model is still told the channel's mention", async () => {
	const snapshot = {
		content: "Reply to the client before nine tomorrow",
		attachments: attachments("plan.pdf"),
	};
	const inbound = await toInbound(
		discordMessage({
			content: "",
			reference: {
				type: MessageReferenceType.Forward,
				channelId: "55",
				guildId: "g2",
				messageId: "9",
			},
			messageSnapshots: { first: () => snapshot },
		}),
		identity,
	);
	expect(inbound?.forwarded).toEqual({
		text: "Reply to the client before nine tomorrow",
		source: "discord:55",
		url: "https://discord.com/channels/g2/55/9",
	});
	expect(inbound?.attachments.map((file) => file.name)).toEqual(["plan.pdf"]);
	const text = withReference(inbound as never, OWNER_IDENTITY);
	expect(text).toContain("from <#55> (https://discord.com/channels/g2/55/9)");
	expect(text).toContain("Reply to the client before nine tomorrow");
});

test("a reply to one of the bot's messages says so, and a replied-to webhook post names its sender", async () => {
	const inbound = await toInbound(
		discordMessage({
			reference: { messageId: "8", type: MessageReferenceType.Default },
			fetchReference: async () => ({
				author: { id: BOT, username: "Scout" },
				content: `<@${BOT}> earlier`,
				webhookId: "hook-2",
				attachments: attachments(),
				embeds: [],
			}),
		}),
		identity,
	);
	expect(inbound?.repliesToBot).toBe(true);
	expect(inbound?.reference).toEqual({
		text: "earlier",
		attachments: [],
		webhookName: "Scout",
	});
});

const alertEmbed = {
	title: "[FIRING:2] HighLoad",
	description: "load is above 8",
	url: "https://alerts.example.com/1",
	fields: [{ name: "host", value: "db-1", inline: false }],
	footer: { text: "Alertmanager" },
	author: null,
};

test("an embed-only webhook post reads as its embed's text", async () => {
	const inbound = await toInbound(
		discordMessage({
			content: "",
			webhookId: "hook-3",
			applicationId: null,
			author: { id: "hook-3", bot: true, username: "Alertmanager" },
			member: null,
			embeds: [alertEmbed],
		}),
		identity,
	);
	expect(inbound?.integration).toEqual({ id: "hook-3", own: false });
	expect(inbound?.text).toBe(
		[
			"[FIRING:2] HighLoad",
			"load is above 8",
			"host: db-1",
			"Alertmanager",
			"https://alerts.example.com/1",
		].join("\n"),
	);
});

test("a message with text and an embed carries both, the bot mention removed from either", async () => {
	const inbound = await toInbound(
		discordMessage({
			content: `<@${BOT}> deploy finished`,
			embeds: [{ ...alertEmbed, title: `ok <@${BOT}>`, fields: [] }],
		}),
		identity,
	);
	expect(inbound?.text.startsWith("deploy finished\n\nok")).toBe(true);
	expect(inbound?.text).not.toContain(BOT);
});

test("a long embed is bounded, and a replied-to message's embed is read too", async () => {
	const inbound = await toInbound(
		discordMessage({
			content: "",
			embeds: [{ ...alertEmbed, description: "y".repeat(20_000) }],
			reference: { messageId: "8", type: MessageReferenceType.Default },
			fetchReference: async () => ({
				author: { id: "5", username: "ci" },
				content: "",
				webhookId: "hook-2",
				attachments: attachments(),
				embeds: [alertEmbed],
			}),
		}),
		identity,
	);
	expect(inbound?.text.length).toBeLessThanOrEqual(4_000);
	expect(inbound?.reference?.text).toContain("[FIRING:2] HighLoad");
});
