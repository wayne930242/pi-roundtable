import { afterEach, describe, expect, test } from "bun:test";
import { hasWebAccess } from "./core/testing/test-host.ts";
import { DISCORD, type DiscordPoster } from "./discord/index.ts";
import { definePlugin } from "./index.ts";
import {
	describeDb,
	fakeDiscord,
	fakeDiscordPoster,
	type TestHost,
	testHost,
	testPlugin,
} from "./testing.ts";

const CHANNEL = "900000000000000301";

test("fakeDiscord hands a plugin the poster the test gave, else a fake of its own", async () => {
	const given = fakeDiscordPoster();
	const withGiven = fakeDiscord({ poster: given });
	expect(withGiven.poster).toBe(given);
	const seen: DiscordPoster[] = [];
	const reader = definePlugin({
		name: "reader",
		setup: ({ services }) => {
			seen.push(services.get(DISCORD).poster);
			return {};
		},
	});
	await (await testPlugin(reader, { services: [withGiven.service] })).stop();
	expect(seen[0]).toBe(given);
	const byDefault = fakeDiscord();
	expect(byDefault.poster).not.toBe(given);
	await byDefault.poster.post(CHANNEL, {
		webhook: "relay",
		username: "Ann",
		content: "hello",
	});
	expect(
		(byDefault.poster as ReturnType<typeof fakeDiscordPoster>).messagesIn(
			CHANNEL,
		),
	).toHaveLength(1);
});

let host: TestHost | undefined;
afterEach(async () => {
	await host?.stop();
	host = undefined;
});

(hasWebAccess() ? describeDb : describe.skip)("testHost's Discord", () => {
	test("DISCORD.poster is the one the test gave, and channelInfo can be replaced", async () => {
		const poster = fakeDiscordPoster();
		host = await testHost({
			discord: {
				poster,
				channelInfo: async (id) => ({ kind: "dm", name: `dm ${id}` }),
			},
		});
		const discord = host.context.services.get(DISCORD);
		expect(discord.poster).toBe(poster);
		expect(await discord.connection.channelInfo("1")).toEqual({
			kind: "dm",
			name: "dm 1",
		});
	});

	test("without a given poster the host has a fake one", async () => {
		host = await testHost();
		const { poster } = host.context.services.get(DISCORD);
		const posted = await poster.say(CHANNEL, { content: "hi" });
		expect(posted.channelId).toBe(CHANNEL);
	});
});
