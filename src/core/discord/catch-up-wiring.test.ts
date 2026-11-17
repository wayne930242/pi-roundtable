import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChannelType, type Client, Events } from "discord.js";
import { DISCORD, discordPlugin } from "../builtin/discord.ts";
import { type RoundtableConfig, resolveConfig } from "../config/config.ts";
import type { InboundMessage } from "../contract/channels.ts";
import { ConfigError } from "../domain/errors.ts";
import { speakerPolicy } from "../identity/speakers.ts";
import { silentLogger } from "../kernel/log.ts";
import type { PluginContext } from "../plugin-api/plugin.ts";
import { THREADS } from "../plugin-api/services.ts";
import { snowflakeAt } from "./catch-up.ts";
import { clientCatchUpReader } from "./catch-up-reader.ts";
import { listenForMessages } from "./message-changes.ts";

const BOT = "900000000000000009";
const READY = Date.parse("2026-11-17T07:00:00Z");
const OPTIONS = {
	token: "token",
	ownerId: "1",
	ownerName: "Ada",
	speakers: speakerPolicy({ owners: ["1"] }),
	rootCommand: "bot",
};

/** The Discord plugin set up alone, over a database stand-in that counts its uses. */
async function setUp(catchUp?: { windowMinutes?: number }) {
	const plugin = discordPlugin({
		...OPTIONS,
		dataDir: mkdtempSync(join(tmpdir(), "roundtable-catch-up-")),
		...(catchUp ? { catchUp } : {}),
	});
	let opened = 0;
	const contribution = await plugin.setup({
		logger: silentLogger(),
		queue: {},
		conversations: {},
		database: () => {
			opened += 1;
			return {};
		},
		services: {
			provide: (key: { id: string }) => {
				if (key.id !== DISCORD.id) throw new Error(`unexpected ${key.id}`);
			},
			find: () => undefined,
			get: (key: { id: string }) => {
				if (key.id === THREADS.id) return {};
				throw new Error(`unexpected service ${key.id}`);
			},
		},
	} as unknown as PluginContext);
	return {
		migrations: (plugin.migrations ?? []).map(({ name }) => name),
		services: (contribution.services ?? []).map(({ name }) => name),
		opened,
	};
}

test("catch-up off: no migration, no database, no catch-up service", async () => {
	expect(await setUp()).toEqual({
		migrations: [],
		services: ["card-copies"],
		opened: 0,
	});
});

test("catch-up on: the journal's migration, and a catch-up service over the database", async () => {
	expect(await setUp({})).toEqual({
		migrations: ["discord-inbound-journal"],
		services: ["card-copies", "discord-catch-up"],
		opened: 1,
	});
});

test("discordPlugin refuses a catch-up window out of range, as the config file does", () => {
	expect(() =>
		discordPlugin({
			...OPTIONS,
			dataDir: "/nowhere",
			catchUp: { windowMinutes: 0 },
		}),
	).toThrow(ConfigError);
});

test("discord.catchUp is left out unless configured, and refuses a value out of range", () => {
	const minimal: RoundtableConfig = {
		owner: { id: "100000000000000001", name: "Ada" },
		discord: { token: "token" },
		agentServer: false,
		database: { url: "postgres://localhost/roundtable" },
		dataDir: "/data",
		model: "anthropic/claude-sonnet-5-5",
	};
	const withCatchUp = (catchUp: unknown) =>
		resolveConfig({
			...minimal,
			discord: { token: "token", catchUp },
			agentServer: false,
		} as RoundtableConfig).discord?.catchUp;
	expect(resolveConfig(minimal).discord?.catchUp).toBeUndefined();
	expect(withCatchUp({ windowMinutes: 5, maxMessages: 3 })).toEqual({
		windowMinutes: 5,
		maxMessages: 3,
	});
	expect(() => withCatchUp({ windowMinutes: 1441 })).toThrow(
		"discord.catchUp.windowMinutes",
	);
	expect(() => withCatchUp({ maxMessages: 0 })).toThrow(
		"discord.catchUp.maxMessages",
	);
});

/** A live message as the gateway hands it to the client. */
function liveMessage(id: string) {
	return {
		id,
		channelId: "77",
		guildId: "g1",
		content: `<@${BOT}> hi`,
		author: { id: "1", bot: false, username: "ada", globalName: "Ada" },
		member: null,
		webhookId: null,
		applicationId: null,
		reference: null,
		messageSnapshots: { first: () => undefined },
		mentions: { users: new Map([[BOT, {}]]) },
		channel: { isDMBased: () => false, isThread: () => false },
		attachments: new Map(),
		embeds: [],
	};
}

test("a live message the gate refuses does not reach routing; one it lets through does", async () => {
	const client = Object.assign(new EventEmitter(), {
		user: { id: BOT },
		application: { id: BOT },
	});
	const delivered: string[] = [];
	const gated: [string, string][] = [];
	listenForMessages(
		client as unknown as Client,
		(message: InboundMessage) => delivered.push(message.messageId),
		silentLogger(),
		async (message, botId) => {
			gated.push([message.messageId, botId]);
			return message.messageId === "let";
		},
	);
	client.emit(Events.MessageCreate, liveMessage("refused"));
	client.emit(Events.MessageCreate, liveMessage("let"));
	await Bun.sleep(5);
	expect(gated).toEqual([
		["refused", BOT],
		["let", BOT],
	]);
	expect(delivered).toEqual(["let"]);
});

test("a message the gate holds longer still reaches routing before the next one of its channel", async () => {
	const client = Object.assign(new EventEmitter(), {
		user: { id: BOT },
		application: { id: BOT },
	});
	const delivered: string[] = [];
	listenForMessages(
		client as unknown as Client,
		(message: InboundMessage) => delivered.push(message.messageId),
		silentLogger(),
		async (message) => {
			if (message.messageId === "slow") await Bun.sleep(20);
			return true;
		},
	);
	client.emit(Events.MessageCreate, liveMessage("slow"));
	client.emit(Events.MessageCreate, liveMessage("quick"));
	await Bun.sleep(40);
	expect(delivered).toEqual(["slow", "quick"]);
});

test("a message that cannot be read while an earlier one waits is logged, and the earlier one still delivered", async () => {
	const client = Object.assign(new EventEmitter(), {
		user: { id: BOT },
		application: { id: BOT },
	});
	const delivered: string[] = [];
	const logged: string[] = [];
	listenForMessages(
		client as unknown as Client,
		(message: InboundMessage) => delivered.push(message.messageId),
		{
			...silentLogger(),
			error: (_: unknown, what: string) => logged.push(what),
		} as never,
		async (message) => {
			if (message.messageId === "slow") await Bun.sleep(20);
			return true;
		},
	);
	client.emit(Events.MessageCreate, liveMessage("slow"));
	client.emit(Events.MessageCreate, {
		...liveMessage("broken"),
		channel: {
			isDMBased: () => {
				throw new Error("unreadable");
			},
			isThread: () => false,
		},
	});
	await Bun.sleep(40);
	expect(delivered).toEqual(["slow"]);
	expect(logged).toEqual(["inbound message could not be read"]);
});

/** A channel in the client's cache, as the reader picks among them. */
function cached(id: string, extra: Record<string, unknown> = {}) {
	return {
		id,
		lastMessageId: snowflakeAt(READY - 60_000),
		isTextBased: () => true,
		isThread: () => false,
		isDMBased: () => false,
		permissionsFor: () => ({ has: () => true }),
		messages: { fetch: async () => new Map() },
		...extra,
	};
}

test("the reader picks the readable text channels, live threads and held direct messages, with no request", () => {
	const channels = [
		cached("1"),
		cached("2", { permissionsFor: () => ({ has: () => false }) }),
		cached("3", { isThread: () => true, archived: true }),
		cached("4", { isThread: () => true, archived: false }),
		cached("5", { isTextBased: () => false, type: ChannelType.GuildForum }),
		cached("6", { isDMBased: () => true, permissionsFor: undefined }),
		cached("7", { lastMessageId: null }),
	];
	const client = {
		user: { id: BOT },
		application: { id: BOT },
		readyTimestamp: READY,
		channels: {
			cache: new Map(channels.map((channel) => [channel.id, channel])),
			fetch: async () => {
				throw new Error("no request expected");
			},
		},
	};
	const reader = clientCatchUpReader(client as unknown as Client);
	expect(reader.readyAt).toBe(READY);
	expect(
		reader
			.channels()
			.map(({ id, direct, lastMessageAt }) => [id, direct, lastMessageAt]),
	).toEqual([
		["1", false, READY - 60_000],
		["4", false, READY - 60_000],
		["6", true, READY - 60_000],
		["7", false, undefined],
	]);
});

test("the reader fetches the author of a server message as a member first, so its roles are read", async () => {
	const members = new Map<string, { roles: { cache: Map<string, object> } }>();
	const message = {
		...liveMessage("m1"),
		inGuild: () => true,
		get member() {
			return members.get("1") ?? null;
		},
		guild: {
			members: {
				fetch: async (id: string) => {
					const member = {
						displayName: "Ada N",
						roles: { cache: new Map([["r1", {}]]) },
					};
					members.set(id, member);
					return member;
				},
			},
		},
	};
	const client = {
		user: { id: BOT },
		application: { id: BOT },
		readyTimestamp: READY,
		channels: { cache: new Map() },
	};
	const reader = clientCatchUpReader(client as unknown as Client);
	const inbound = await reader.inbound(message as never);
	expect(inbound?.authorRoleIds).toEqual(["r1"]);
	expect(inbound?.mentionsBot).toBe(true);
});
