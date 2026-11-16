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

function withConversation(conversation: unknown) {
	return resolveConfig({
		...minimal,
		discord: { ...minimal.discord, channelContext: { conversation } },
	} as RoundtableConfig).discord?.channelContext;
}

test("discord.channelContext takes conversation, a function naming the conversation a turn runs in", () => {
	const conversation = (message: { authorId: string }) => message.authorId;
	expect(withConversation(conversation)).toEqual({ conversation });
});

test("discord.channelContext refuses a conversation that is not a function, naming it", () => {
	expect(() => withConversation("alice")).toThrow(ConfigError);
	expect(() => withConversation("alice")).toThrow(
		"config discord.channelContext.conversation",
	);
});

test("discord.channelContext takes authors, the host's default verdict on whose a message is", () => {
	const authors = () => "keep" as const;
	expect(
		resolveConfig({
			...minimal,
			discord: { ...minimal.discord, channelContext: { authors } },
		} as RoundtableConfig).discord?.channelContext,
	).toEqual({ authors });
});
