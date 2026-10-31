import { afterEach, describe, expect, test } from "bun:test";
import {
	ButtonStyle,
	ChannelType,
	type Client,
	type Interaction,
	MessageFlags,
	type WebhookMessageCreateOptions,
} from "discord.js";
import type { IntercomCard } from "../domain/conversation.ts";
import { messages } from "../i18n/index.ts";
import { silentLogger } from "../log.ts";
import { useTestLocale } from "../testing/locale.ts";
import { DiscordAgentChannels } from "./agent-discord.ts";
import { CardCopies } from "./card-copies.ts";
import {
	INTERCOM_BUTTON_PREFIX,
	intercomButtonModule,
	intercomReplies,
} from "./intercom-cards.ts";

afterEach(() => useTestLocale());

/** Agent channels over one webhook that records what it sends. */
function channelsWithTexts() {
	const sent: WebhookMessageCreateOptions[] = [];
	const webhook = {
		send: async (payload: WebhookMessageCreateOptions) => {
			sent.push(payload);
		},
	};
	const client = {
		channels: {
			fetch: async () => ({
				type: ChannelType.GuildText,
				isThread: () => false,
				fetchWebhooks: async () => ({ find: () => undefined }),
				createWebhook: async () => webhook,
			}),
		},
	} as unknown as Client;
	const texts = new CardCopies({ logger: silentLogger() });
	return {
		channels: new DiscordAgentChannels(client, "guild", texts),
		sent,
		texts,
	};
}

const peer = { name: "infra", displayName: "Infrastructure" };

/** The custom id of the first button of a sent payload, if it has one. */
function buttonOf(payload: WebhookMessageCreateOptions | undefined) {
	const row = payload?.components?.[0];
	if (!row || !("toJSON" in row)) return undefined;
	const json = row.toJSON() as {
		components: { custom_id: string; label: string; style: number }[];
	};
	return json.components[0];
}

/** A button press on `customId` that records what it is answered. */
function press(customId: string) {
	const answers: { content?: string; flags?: unknown; files?: unknown[] }[] =
		[];
	const interaction = {
		isButton: () => true,
		customId,
		reply: async (body: (typeof answers)[number]) => void answers.push(body),
		followUp: async (body: (typeof answers)[number]) => void answers.push(body),
	} as unknown as Interaction;
	return { interaction, answers };
}

describe("intercom cards on Discord", () => {
	test("a request posts as one small line with an open button, never as its chunks or a thread", async () => {
		const { channels, sent, texts } = channelsWithTexts();
		const card: IntercomCard = {
			kind: "sent",
			peer,
			text: "check the disk\nand the logs",
		};
		await channels.post("1000", {
			name: "Coordinator",
			avatarUrl: "https://x/a.png",
			chunks: ["the plain fallback"],
			intercom: card,
		});
		expect(sent).toHaveLength(1);
		const payload = sent[0];
		expect(payload?.username).toBe("Coordinator");
		expect(payload?.content).toBe(
			`-# ${messages().intercomLine(messages().intercomSent("Infrastructure"), "check the disk")}`,
		);
		expect(payload?.threadId).toBeUndefined();
		expect(payload?.withComponents).toBe(true);
		expect(payload?.allowedMentions).toEqual({ parse: [] });
		const button = buttonOf(payload);
		expect(button?.label).toBe(messages().intercomExpand);
		expect(button?.style).toBe(ButtonStyle.Secondary);
		const id = button?.custom_id.slice(INTERCOM_BUTTON_PREFIX.length) ?? "";
		expect(texts.recall(id)).toBe(card.text);
	});

	test("an answer and a failure post their own headings; a short one-line text needs no button", async () => {
		const { channels, sent } = channelsWithTexts();
		const as = { name: "Infrastructure", avatarUrl: "https://x/b.png" };
		await channels.post("1000", {
			...as,
			chunks: [],
			intercom: { kind: "answered", peer, text: "disk 80%" },
		});
		await channels.post("1000", {
			...as,
			chunks: [],
			intercom: { kind: "failed", peer, text: "stopped by the owner" },
		});
		expect(sent.map((p) => p.content)).toEqual([
			`-# ${messages().intercomLine(messages().intercomAnswered("Infrastructure"), "disk 80%")}`,
			`-# ${messages().intercomLine(messages().intercomFailed("Infrastructure"), "stopped by the owner")}`,
		]);
		expect(sent.map((p) => p.components)).toEqual([undefined, undefined]);
	});

	test("the headings read in Traditional Chinese on a host in that language", async () => {
		useTestLocale({ locale: "zh-TW" });
		const { channels, sent } = channelsWithTexts();
		await channels.post("1000", {
			name: "Coordinator",
			avatarUrl: "https://x/a.png",
			chunks: [],
			intercom: { kind: "sent", peer, text: "看一下磁碟\n還有日誌" },
		});
		expect(sent[0]?.content).toBe("-# → 給 **Infrastructure**：看一下磁碟");
		expect(buttonOf(sent[0])?.label).toBe("展開全文");
	});

	test("without a place to keep texts a card posts as its plain chunks", async () => {
		const sent: WebhookMessageCreateOptions[] = [];
		const client = {
			channels: {
				fetch: async () => ({
					type: ChannelType.GuildText,
					isThread: () => false,
					fetchWebhooks: async () => ({ find: () => undefined }),
					createWebhook: async () => ({
						send: async (payload: WebhookMessageCreateOptions) =>
							void sent.push(payload),
					}),
				}),
			},
		} as unknown as Client;
		await new DiscordAgentChannels(client, "guild").post("1000", {
			name: "Coordinator",
			avatarUrl: "https://x/a.png",
			chunks: ["→ To **Infrastructure**\nx"],
			intercom: { kind: "sent", peer, text: "x" },
		});
		expect(sent.map((p) => p.content)).toEqual(["→ To **Infrastructure**\nx"]);
	});

	test("pressing the open button shows the whole text to whoever pressed, split within Discord's limit", async () => {
		const texts = new CardCopies({ logger: silentLogger() });
		const long = Array.from(
			{ length: 3 },
			(_, i) => `${"word ".repeat(300)}${i}`,
		).join("\n\n");
		texts.remember("abc", long);
		const module = intercomButtonModule(texts);
		const { interaction, answers } = press(`${INTERCOM_BUTTON_PREFIX}abc`);
		expect(await module.handle(interaction)).toBe(true);
		expect(answers.length).toBeGreaterThan(1);
		for (const answer of answers) {
			expect(answer.flags).toBe(MessageFlags.Ephemeral);
			expect(answer.content?.length).toBeLessThanOrEqual(2000);
		}
		expect(answers.map((a) => a.content).join("\n\n")).toBe(long);
	});

	test("a text too long for a few messages comes as one file; a text no longer kept is said to be gone", async () => {
		const huge = Array.from({ length: 20 }, () => "x ".repeat(900)).join(
			"\n\n",
		);
		const [only, ...rest] = intercomReplies(huge);
		expect(rest).toEqual([]);
		expect(only?.content).toBe(messages().cardCopyFile);
		expect(only && "files" in only ? only.files : []).toHaveLength(1);

		const module = intercomButtonModule(
			new CardCopies({ logger: silentLogger() }),
		);
		const { interaction, answers } = press(`${INTERCOM_BUTTON_PREFIX}gone`);
		expect(await module.handle(interaction)).toBe(true);
		expect(answers).toEqual([
			{ content: messages().intercomGone, flags: MessageFlags.Ephemeral },
		]);
	});

	test("other buttons are left to their own modules", async () => {
		const module = intercomButtonModule(
			new CardCopies({ logger: silentLogger() }),
		);
		expect(await module.handle(press("roundtable:stop").interaction)).toBe(
			false,
		);
	});
});
