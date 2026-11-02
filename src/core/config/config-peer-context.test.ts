import { expect, test } from "bun:test";
import { ConfigError } from "../domain/errors.ts";
import { type RoundtableConfig, resolveConfig } from "./config.ts";

const minimal: RoundtableConfig = {
	owner: { id: "100000000000000001", name: "Ada" },
	discord: {
		token: "token",
		guild: "900000000000000001",
		entryChannel: "900000000000000002",
	},
	database: { url: "postgres://localhost/roundtable" },
	dataDir: "/data",
	model: "anthropic/claude-sonnet-5-5",
	http: { publicUrl: "https://bot.example.com" },
};

function withPeerChars(peerMessageChars: unknown) {
	return resolveConfig({
		...minimal,
		discord: { ...minimal.discord, channelContext: { peerMessageChars } },
	} as RoundtableConfig).discord?.channelContext;
}

test("discord.channelContext takes peerMessageChars, where a peer bot's message is cut", () => {
	expect(withPeerChars(2000)).toEqual({ peerMessageChars: 2000 });
});

test("discord.channelContext refuses a peerMessageChars over 4000, naming it", () => {
	expect(() => withPeerChars(4001)).toThrow(ConfigError);
	expect(() => withPeerChars(4001)).toThrow(
		"config discord.channelContext.peerMessageChars: expected an integer from 1 to 4000",
	);
});
