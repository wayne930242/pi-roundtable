import { describe, expect, test } from "bun:test";
import { PermissionFlagsBits } from "discord.js";
import { INVITE_PERMISSIONS } from "../discord-api.ts";
import { Project } from "../project.ts";
import type { Result } from "../report.ts";
import {
	BOT_ID,
	fakeHttp,
	fakePorts,
	healthyDiscord,
	validConfig,
} from "../testing/fixtures.ts";
import {
	checkChannel,
	checkGuild,
	checkIntents,
	checkToken,
	Discord,
} from "./discord.ts";

const guild = validConfig.discord.guild;
const channel = validConfig.discord.entryChannel;
const project = (config: unknown = validConfig) =>
	new Project("/x", fakePorts(config));

function failure(result: Result): string {
	if (result.status !== "fail")
		throw new Error(`expected a failure, got ${JSON.stringify(result)}`);
	return `${result.problem}\n${result.fix}`;
}

const all = INVITE_PERMISSIONS;
const bit = (name: keyof typeof PermissionFlagsBits): bigint =>
	PermissionFlagsBits[name];
const without = (name: keyof typeof PermissionFlagsBits): bigint =>
	all & ~bit(name);

describe("Discord token", () => {
	test("passes and names the bot", async () => {
		const http = fakeHttp(healthyDiscord(all));
		const result = await checkToken(new Discord(project(), http));
		expect(result).toEqual({ status: "ok", detail: "the bot is Bot" });
	});
	test("fails on a rejected token with where to reset it", async () => {
		const http = fakeHttp({ "/users/@me": { status: 401, body: {} } });
		const text = failure(await checkToken(new Discord(project(), http)));
		expect(text).toContain("rejected the bot token");
		expect(text).toContain("DISCORD_TOKEN");
		expect(text).toContain("discord.com/developers");
	});
	test("fails when Discord cannot be reached, without a stack trace", async () => {
		const http = fakeHttp({ "/users/@me": new Error("getaddrinfo ENOTFOUND") });
		const text = failure(await checkToken(new Discord(project(), http)));
		expect(text).toContain("cannot reach discord.com: getaddrinfo ENOTFOUND");
		expect(text).toContain("network");
	});
	test("skips without a token, and sends the token as the bot's authorization", async () => {
		const none = project({
			...validConfig,
			discord: { ...validConfig.discord, token: "" },
		});
		expect((await checkToken(new Discord(none, fakeHttp({})))).status).toBe(
			"skipped",
		);
		let seen: Record<string, string> | undefined;
		await checkToken(
			new Discord(project(), {
				get: async (_url, headers) => {
					seen = headers;
					return { status: 200, body: { id: BOT_ID } };
				},
			}),
		);
		expect(seen).toEqual({ Authorization: "Bot bot-token" });
	});
	test("asks Discord once for who the bot is however many checks need it", async () => {
		const http = fakeHttp(healthyDiscord(all));
		const discord = new Discord(project(), http);
		await checkToken(discord);
		await checkGuild(project(), discord);
		await checkChannel(project(), discord);
		expect(http.requests.filter((path) => path === "/users/@me")).toHaveLength(
			1,
		);
	});
});

describe("Discord guild", () => {
	test("passes when the bot is in the guild", async () => {
		const http = fakeHttp(healthyDiscord(all));
		const result = await checkGuild(project(), new Discord(project(), http));
		expect(result).toEqual({
			status: "ok",
			detail: "the bot is in Test Guild",
		});
	});
	test("fails when it is not, with an invitation that asks for what the bot needs", async () => {
		const http = fakeHttp({
			...healthyDiscord(all),
			[`/guilds/${guild}`]: { status: 404, body: { code: 10004 } },
		});
		const text = failure(
			await checkGuild(project(), new Discord(project(), http)),
		);
		expect(text).toContain(`not in the guild ${guild}`);
		expect(text).toContain(`client_id=${BOT_ID}`);
		expect(text).toContain(`permissions=${INVITE_PERMISSIONS}`);
	});
	test("is skipped when the token failed", async () => {
		const http = fakeHttp({ "/users/@me": { status: 401, body: {} } });
		expect(
			(await checkGuild(project(), new Discord(project(), http))).status,
		).toBe("skipped");
	});
});

describe("Discord intents", () => {
	test("passes with the Message Content intent, granted or limited", async () => {
		for (const flags of [1 << 18, 1 << 19]) {
			const http = fakeHttp({
				...healthyDiscord(all),
				"/applications/@me": { status: 200, body: { flags } },
			});
			expect((await checkIntents(new Discord(project(), http))).status).toBe(
				"ok",
			);
		}
	});
	test("fails without it, saying where to turn it on", async () => {
		const http = fakeHttp({
			...healthyDiscord(all),
			"/applications/@me": { status: 200, body: { flags: 0 } },
		});
		const text = failure(await checkIntents(new Discord(project(), http)));
		expect(text).toContain("Message Content intent is off");
		expect(text).toContain("Bot in https://discord.com/developers");
	});
});

describe("Discord channel", () => {
	const check = (routes: Record<string, never> | object) =>
		checkChannel(project(), new Discord(project(), fakeHttp(routes as never)));
	test("passes when the bot has every permission", async () => {
		expect((await check(healthyDiscord(all))).status).toBe("ok");
	});
	test("fails naming the permission the bot lacks, Pin Messages included, and why it is needed", async () => {
		const text = failure(await check(healthyDiscord(without("PinMessages"))));
		expect(text).toContain("lacks PinMessages");
		expect(text).toContain("pin the dashboard");
	});
	test("a channel overwrite that denies a permission counts, and an allow restores it", async () => {
		const pin = bit("PinMessages");
		const denied = healthyDiscord(all);
		denied[`/channels/${channel}`] = {
			status: 200,
			body: {
				guild_id: guild,
				permission_overwrites: [
					{ id: "700000000000000001", type: 0, allow: "0", deny: String(pin) },
				],
			},
		};
		expect(failure(await check(denied))).toContain("PinMessages");
		const restored = healthyDiscord(all);
		restored[`/channels/${channel}`] = {
			status: 200,
			body: {
				guild_id: guild,
				permission_overwrites: [
					{ id: guild, type: 0, allow: "0", deny: String(pin) },
					{ id: BOT_ID, type: 1, allow: String(pin), deny: "0" },
				],
			},
		};
		expect((await check(restored)).status).toBe("ok");
	});
	test("the owner of the guild and an administrator have every permission", async () => {
		const administrator = 1n << 3n;
		expect((await check(healthyDiscord(administrator))).status).toBe("ok");
	});
	test("fails when the channel does not exist or is in another guild", async () => {
		const missing = healthyDiscord(all);
		missing[`/channels/${channel}`] = { status: 404, body: {} };
		expect(failure(await check(missing))).toContain("DISCORD_ENTRY_CHANNEL_ID");
		const elsewhere = healthyDiscord(all);
		elsewhere[`/channels/${channel}`] = {
			status: 200,
			body: { guild_id: "999", permission_overwrites: [] },
		};
		expect(failure(await check(elsewhere))).toContain("another guild");
	});
	test("is skipped without the channel or guild value", async () => {
		const empty = project({
			...validConfig,
			discord: { ...validConfig.discord, entryChannel: "" },
		});
		const result = await checkChannel(empty, new Discord(empty, fakeHttp({})));
		expect(result.status).toBe("skipped");
	});
});
