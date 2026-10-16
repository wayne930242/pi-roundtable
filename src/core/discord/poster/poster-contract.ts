import { expect, test } from "bun:test";
import type { DiscordCard } from "./poster.ts";
import { guildScenarios } from "./poster-contract-guild.ts";
import {
	expectFailure,
	freshId,
	type PosterSubject,
	type Scenario,
} from "./poster-contract-support.ts";

export type {
	PosterSubject,
	PosterWorld,
	Scenario,
} from "./poster-contract-support.ts";

const USER = "900000000000000777";
const PNG = Uint8Array.from([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1,
]);
const CARD: DiscordCard = {
	accent: 0x336699,
	title: "Ticket",
	sections: ["first", "second"],
	footer: "quiet",
	buttons: [{ customId: "go:1", label: "Go", style: "primary" }],
	links: [{ label: "Open", url: "https://example.test/t/1" }],
	selects: [
		{
			customId: "pick:1",
			placeholder: "State",
			options: [
				{ label: "Open", value: "open", selected: true },
				{ label: "Done", value: "done" },
			],
		},
	],
};

const messageScenarios: Scenario[] = [
	{
		name: "1. a post goes through the named webhook; two names are two webhooks; someone else's same-named webhook is not used",
		async run({ poster, world }) {
			const ch = freshId();
			world.channel(ch);
			const foreign = world.foreignWebhook(ch, "relay");
			const a = await poster.post(ch, {
				webhook: "relay",
				username: "Ann",
				content: "hello",
				files: [
					{
						name: "a.txt",
						data: new TextEncoder().encode("abc"),
						contentType: "text/plain",
					},
				],
			});
			const b = await poster.post(ch, {
				webhook: "relay notices",
				username: "Ann",
				content: "note",
			});
			const ids = await poster.webhookIds(ch, [
				"relay",
				"relay notices",
				"unused",
			]);
			const first = await poster.message(ch, a.messageId);
			const second = await poster.message(ch, b.messageId);
			expect(first.content).toBe("hello");
			expect(first.webhookId).toBe(ids.relay?.[0]);
			expect(first.authorId).toBe(first.webhookId ?? "");
			expect(
				first.files.map((f) => [f.name, f.size, f.contentType.split(";")[0]]),
			).toEqual([["a.txt", 3, "text/plain"]]);
			expect(second.webhookId).toBe(ids["relay notices"]?.[0]);
			expect(second.webhookId).not.toBe(first.webhookId);
			expect(ids.relay).toHaveLength(1);
			expect(ids.relay?.[0]).not.toBe(foreign);
			expect(ids.unused).toEqual([]);
		},
	},
	{
		name: "2. what Discord would refuse is refused before any request",
		async run({ poster, world }) {
			const ch = freshId();
			world.channel(ch);
			const ok = { webhook: "relay", username: "Ann", content: "x" };
			const refused = (extra: Record<string, unknown>) =>
				expectFailure(poster.post(ch, { ...ok, ...extra }), "invalid");
			const before = world.requests();
			await refused({ username: "" });
			await refused({ username: "a".repeat(81) });
			await refused({ username: "my Discord bot" });
			await refused({ username: "\uFF23\uFF4C\uFF59\uFF44\uFF45" });
			await refused({ username: "everyone" });
			await refused({ webhook: "discord relay" });
			await refused({ webhook: "" });
			await refused({ content: "a".repeat(2_001) });
			await refused({ content: undefined });
			await refused({
				content: undefined,
				files: Array.from({ length: 11 }, (_, i) => ({
					name: `${i}`,
					data: new Uint8Array(1),
				})),
			});
			await refused({
				files: [{ name: "big", data: new Uint8Array(10 * 1024 * 1024 + 1) }],
			});
			await refused({
				mentions: Array.from(
					{ length: 21 },
					(_, i) => `9000000000000001${10 + i}`,
				),
			});
			await refused({ mentions: ["not-an-id"] });
			await expectFailure(poster.post("nope", ok), "invalid");
			await expectFailure(
				poster.setAvatar(ch, "relay", new Uint8Array(1024 * 1024 + 1)),
				"invalid",
			);
			await expectFailure(
				poster.setAvatar(ch, "relay", new Uint8Array([1, 2, 3])),
				"invalid",
			);
			await expectFailure(
				poster.sayCard(ch, { ...CARD, sections: ["x".repeat(3_801)] }),
				"invalid",
			);
			await expectFailure(
				poster.sayCard(ch, {
					title: "t",
					sections: [],
					buttons: Array.from({ length: 6 }, (_, i) => ({
						customId: `b${i}`,
						label: "b",
						style: "primary" as const,
					})),
				}),
				"invalid",
			);
			await expectFailure(
				poster.sendDirect(USER, "x".repeat(2_001)),
				"invalid",
			);
			expect(world.requests()).toBe(before);
		},
	},
	{
		name: "3. nothing pings but the users named: parse is empty on posts, edits, cards and direct messages",
		async run({ poster, world }) {
			const ch = freshId();
			world.channel(ch);
			const posted = await poster.post(ch, {
				webhook: "relay",
				username: "Ann",
				content: "<@&1> @everyone hi",
				mentions: [USER, USER],
			});
			expect(world.mentionsOf(ch, posted.messageId)).toEqual({
				parse: [],
				users: [USER],
			});
			await poster.edit(ch, posted.messageId, { content: "<@&1> again" }, [
				"relay",
			]);
			expect(world.mentionsOf(ch, posted.messageId)).toEqual({
				parse: [],
				users: [],
			});
			const said = await poster.say(ch, {
				content: "@everyone",
				mentions: [USER],
			});
			expect(world.mentionsOf(ch, said.messageId)).toEqual({
				parse: [],
				users: [USER],
			});
			const card = await poster.sayCard(ch, CARD);
			expect(world.mentionsOf(ch, card.messageId)?.parse).toEqual([]);
			expect(world.mentionsOf(ch, card.messageId)?.users ?? []).toEqual([]);
			await poster.sendDirect(USER, "@everyone hi");
			expect(world.directMentions(USER).at(-1)).toEqual({
				parse: [],
				users: [],
			});
		},
	},
	{
		name: "4. edit reaches the named webhooks in order and makes none",
		async run({ poster, world }) {
			const ch = freshId();
			world.channel(ch);
			const one = await poster.post(ch, {
				webhook: "relay",
				username: "A",
				content: "one",
			});
			const two = await poster.post(ch, {
				webhook: "relay staff",
				username: "A",
				content: "two",
			});
			const bot = await poster.say(ch, { content: "bot" });
			await poster.edit(ch, one.messageId, { content: "one!" }, [
				"relay",
				"relay staff",
			]);
			await poster.edit(ch, two.messageId, { content: "two!" }, [
				"relay",
				"relay staff",
			]);
			expect((await poster.message(ch, one.messageId)).content).toBe("one!");
			expect((await poster.message(ch, two.messageId)).content).toBe("two!");
			await expectFailure(
				poster.edit(ch, one.messageId, { content: "no" }, ["relay staff"]),
				"message_gone",
			);
			await expectFailure(
				poster.edit(ch, bot.messageId, { content: "no" }, [
					"relay",
					"relay staff",
				]),
				"message_gone",
			);
			await expectFailure(
				poster.edit(ch, "900000000000099999", { content: "no" }, ["relay"]),
				"message_gone",
			);
			await expectFailure(
				poster.edit(ch, one.messageId, { content: "no" }, ["relay never made"]),
				"message_gone",
			);
			expect(
				(await poster.webhookIds(ch, ["relay never made"]))["relay never made"],
			).toEqual([]);
			expect((await poster.message(ch, one.messageId)).content).toBe("one!");
		},
	},
	{
		name: "5. remove deletes through a named webhook, else as the bot; a gone message says so",
		async run({ poster, world }) {
			const ch = freshId();
			world.channel(ch);
			const one = await poster.post(ch, {
				webhook: "relay",
				username: "A",
				content: "one",
			});
			const two = await poster.post(ch, {
				webhook: "relay staff",
				username: "A",
				content: "two",
			});
			await poster.remove(ch, two.messageId, ["relay", "relay staff"]);
			await expectFailure(poster.message(ch, two.messageId), "message_gone");
			// The webhook that posted `one` is deleted by hand and made again by the next post.
			world.deleteWebhook(ch, "relay");
			await poster.post(ch, {
				webhook: "relay",
				username: "A",
				content: "three",
			});
			await poster.remove(ch, one.messageId, ["relay"]);
			await expectFailure(poster.message(ch, one.messageId), "message_gone");
			await expectFailure(
				poster.remove(ch, one.messageId, ["relay"]),
				"message_gone",
			);
			await expectFailure(
				poster.remove(ch, "900000000000099999", []),
				"message_gone",
			);
		},
	},
	{
		name: "6. a webhook made again is announced once; detaching stops it",
		async run({ poster, world }) {
			const ch = freshId();
			world.channel(ch);
			const heard: string[] = [];
			const detach = poster.onWebhookMade(async (channel, name) => {
				heard.push(`${channel}:${name}`);
			});
			const post = () =>
				poster.post(ch, { webhook: "relay", username: "A", content: "x" });
			await post();
			await post();
			expect(heard).toEqual([`${ch}:relay`]);
			world.deleteWebhook(ch, "relay");
			await post();
			expect(heard).toEqual([`${ch}:relay`, `${ch}:relay`]);
			// A listener that fails never fails the call.
			poster.onWebhookMade(async () => {
				throw new Error("boom");
			});
			world.deleteWebhook(ch, "relay");
			await post();
			detach();
			world.deleteWebhook(ch, "relay");
			await post();
			expect(heard).toHaveLength(3);
			// The picture is set on the named webhook, which is made for it when it is missing.
			await poster.setAvatar(ch, "relay avatars", PNG);
			expect(
				(await poster.webhookIds(ch, ["relay avatars"]))["relay avatars"],
			).toHaveLength(1);
		},
	},
	{
		name: "7. pins: idempotent, newest first across pages, 250 at most; pin notices can be listed and deleted",
		async run({ poster, world }) {
			const ch = freshId();
			world.channel(ch);
			const ids: string[] = [];
			for (let i = 0; i < 251; i += 1) {
				ids.push((await poster.say(ch, { content: `m${i}` })).messageId);
			}
			for (const id of ids.slice(0, 60)) await poster.pin(ch, id);
			await poster.pin(ch, ids[0] as string);
			const sixty = await poster.pinnedIds(ch);
			expect(sixty).toEqual(ids.slice(0, 60).reverse());
			await poster.unpin(ch, ids[59] as string);
			expect(await poster.pinnedIds(ch)).toEqual(ids.slice(0, 59).reverse());
			for (const id of ids.slice(59, 250)) await poster.pin(ch, id);
			expect(await poster.pinnedIds(ch)).toHaveLength(250);
			await expectFailure(poster.pin(ch, ids[250] as string), "rejected");
			await expectFailure(poster.pin(ch, "900000000000099999"), "message_gone");
			// With notices on, a pin leaves the system message Discord leaves.
			world.pinNotices(true);
			const other = freshId();
			world.channel(other);
			const said = await poster.say(other, { content: "pinned" });
			await poster.pin(other, said.messageId);
			const bot = await poster.botUserId();
			const recent = await poster.recentMessages(other, 5);
			const notice = recent.find((m) => m.type === 6);
			expect(notice?.referencedMessageId).toBe(said.messageId);
			expect(notice?.authorId).toBe(bot);
			expect(recent.map((m) => m.id)[1]).toBe(said.messageId);
			await poster.deleteAsBot(other, (notice as { id: string }).id);
			expect(
				(await poster.recentMessages(other, 5)).every((m) => m.type === 0),
			).toBe(true);
			world.pinNotices(false);
		},
	},
	{
		name: "8. cards stay Components V2 on edit; a message posted without the flag cannot become one",
		async run({ poster, world }) {
			const ch = freshId();
			world.channel(ch);
			const card = await poster.sayCard(ch, CARD);
			expect(world.isCard(ch, card.messageId)).toBe(true);
			await poster.editCard(ch, card.messageId, {
				...CARD,
				title: "Ticket 2",
				buttons: [],
			});
			expect(world.isCard(ch, card.messageId)).toBe(true);
			const plain = await poster.say(ch, { content: "plain" });
			await expectFailure(
				poster.editCard(ch, plain.messageId, CARD),
				"rejected",
			);
			await expectFailure(
				poster.editCard(ch, "900000000000099999", CARD),
				"message_gone",
			);
			await poster.deleteAsBot(ch, card.messageId);
			await expectFailure(
				poster.deleteAsBot(ch, card.messageId),
				"message_gone",
			);
			expect((await poster.recentMessages(ch, 10)).map((m) => m.id)).toEqual([
				plain.messageId,
			]);
		},
	},
	{
		name: "9. a direct message is sent, or answered closed when the person takes none",
		async run({ poster, world }) {
			const open = "900000000000000881";
			const shut = "900000000000000882";
			expect(await poster.sendDirect(open, "hello")).toBe("sent");
			world.closeDirects(shut);
			expect(await poster.sendDirect(shut, "hello")).toBe("closed");
			expect(world.directMentions(open)).toHaveLength(1);
			expect(world.directMentions(shut)).toHaveLength(0);
		},
	},
];

/** The contract the real poster (over an emulated Discord) and the fake both keep. */
export const posterScenarios: Scenario[] = [
	...messageScenarios,
	...guildScenarios,
];

/** Registers every scenario as a test over a subject made fresh for it. */
export function runContract(
	label: string,
	make: () => PosterSubject,
	skip: readonly string[] = [],
): void {
	for (const scenario of posterScenarios) {
		if (skip.includes(scenario.name)) continue;
		test(`${label}: ${scenario.name}`, async () => {
			const subject = make();
			try {
				await scenario.run(subject);
			} finally {
				subject.close();
			}
		}, 30_000);
	}
}
