import { afterEach, expect, spyOn, test } from "bun:test";
import { Client, Collection, Events } from "discord.js";
import type { InboundMessage } from "../domain/conversation.ts";
import { silentLogger } from "../log.ts";
import { DiscordSurface } from "./discord-surface.ts";

const BOT = "900000000000000001";
const CHANNEL = "700000000000000001";
const GUILD = "600000000000000001";

afterEach(() => {
	// biome-ignore lint/suspicious/noExplicitAny: restores whatever spy a test left
	(Client.prototype.login as any).mockRestore?.();
});

/** Starts a surface over a client that never connects, and hands back the client to emit events on. */
async function started() {
	let client: Client | undefined;
	spyOn(Client.prototype, "login").mockImplementation(async function (
		this: Client,
	) {
		client = this;
		Object.defineProperty(this, "user", { value: { id: BOT } });
		queueMicrotask(() => this.emit(Events.ClientReady, this as never));
		return "token";
	});
	const surface = new DiscordSurface({
		token: "token",
		ownerId: "100",
		ownerName: "Ada",
		prompts: () => undefined,
		logger: silentLogger(),
	});
	const deleted: string[] = [];
	const edited: InboundMessage[] = [];
	await surface.start(() => undefined, {
		deleted: (channel, id, space) =>
			void deleted.push(`${channel} ${id} ${space ?? "-"}`),
		edited: (message) => void edited.push(message),
	});
	if (!client) throw new Error("the client did not start");
	return { client, deleted, edited };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

function fake(content: string, extra: Record<string, unknown> = {}) {
	return {
		partial: false,
		id: "m1",
		channelId: CHANNEL,
		guildId: GUILD,
		content,
		embeds: [],
		attachments: new Collection(),
		author: { id: "200", bot: false, username: "ada", globalName: "Ada" },
		member: null,
		webhookId: null,
		mentions: { users: new Collection() },
		reference: null,
		channel: { isDMBased: () => false },
		...extra,
	};
}

test("a deleted message is reported by id with its server, and a bulk delete one by one", async () => {
	const { client, deleted } = await started();
	client.emit(Events.MessageDelete, fake("x") as never);
	client.emit(
		Events.MessageBulkDelete,
		new Collection([
			["a", fake("x")],
			["b", fake("y")],
		]) as never,
		{ id: CHANNEL, guildId: GUILD } as never,
	);
	expect(deleted).toEqual([
		`discord:${CHANNEL} m1 ${GUILD}`,
		`discord:${CHANNEL} a ${GUILD}`,
		`discord:${CHANNEL} b ${GUILD}`,
	]);
});

test("an edit that changes the words is reported as the neutral message", async () => {
	const { client, edited } = await started();
	client.emit(Events.MessageUpdate, fake("old") as never, fake("new") as never);
	await tick();
	expect(edited.map((m) => [m.messageId, m.text, m.channel])).toEqual([
		["m1", "new", `discord:${CHANNEL}`],
	]);
});

test("an edit that changes nothing a claim keeps, and the bot's own, are not reported", async () => {
	const { client, edited } = await started();
	client.emit(
		Events.MessageUpdate,
		fake("same") as never,
		fake("same") as never,
	);
	client.emit(
		Events.MessageUpdate,
		fake("old") as never,
		fake("new", { author: { id: BOT, bot: true, username: "me" } }) as never,
	);
	await tick();
	expect(edited).toEqual([]);
});

test("an edit of an uncached message is fetched before it is read", async () => {
	const { client, edited } = await started();
	const partial = {
		partial: true,
		fetch: async () => fake("fetched"),
	};
	client.emit(
		Events.MessageUpdate,
		{ partial: true } as never,
		partial as never,
	);
	await tick();
	expect(edited.map((m) => m.text)).toEqual(["fetched"]);
});
