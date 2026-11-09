import { expect, test } from "bun:test";
import type { Client } from "discord.js";
import type { AgentChannels } from "../agents/agent-ports.ts";
import { silentLogger } from "../kernel/log.ts";
import { discordPlaceProvider, discordPlaces } from "./agent-places.ts";

const GUILD = "900000000000000001";

/** A connection that records what the provider asks of it. */
function connection() {
	const asked: string[] = [];
	const listeners: ((id: string) => void)[] = [];
	// SAFETY: the provider only passes the channels on; these tests never post through them.
	const channels = {} as AgentChannels;
	return {
		asked,
		listeners,
		connection: {
			agentChannels: (guild: string) => {
				asked.push(guild);
				return channels;
			},
			onChannelDeleted: (listener: (id: string) => void) =>
				void listeners.push(listener),
		},
	};
}

test("a replacement's Discord provider has the keys, seats, log names and space of the built-in one", () => {
	const { connection: wired } = connection();
	const ready = discordPlaceProvider({
		guild: GUILD,
		connection: wired,
		logger: silentLogger(),
	});
	const builtin = discordPlaces({
		// SAFETY: a provider that is only read never asks the client or the channels.
		client: undefined as never,
		guild: GUILD,
		channels: undefined as never,
		onRemoved: () => undefined,
		logger: silentLogger(),
	});
	expect(ready.surface).toBe("discord");
	expect(ready.storage).toBe("stored");
	expect(ready.space).toBe(GUILD);
	expect(ready.key({ kind: "agent", name: "a" }, "42")).toBe("discord:42");
	expect(ready.placeOf("discord:42")).toEqual({ id: "42" });
	expect(ready.placeOf("app:agent.a")).toBeUndefined();
	expect(ready.mention?.("discord:42")).toBe("<#42>");
	expect(ready.conversations?.seat("555", "coder")).toBe(
		"agentgroup:555.coder",
	);
	expect(ready.conversations?.log("ops")).toBe("ops");
	expect(Object.keys(ready.createArguments?.agent ?? {})).toEqual(
		Object.keys(builtin.createArguments?.agent ?? {}),
	);
	expect(Object.keys(ready.createArguments?.group ?? {})).toEqual(
		Object.keys(builtin.createArguments?.group ?? {}),
	);
});

test("it reads the agent guild's channels and deleted channels from the connection", () => {
	const { connection: wired, asked, listeners } = connection();
	const provider = discordPlaceProvider({
		guild: GUILD,
		connection: wired,
		logger: silentLogger(),
	});
	expect(asked).toEqual([GUILD]);
	const removed: string[] = [];
	provider.onRemoved?.((id) => void removed.push(id));
	listeners[0]?.("7");
	expect(removed).toEqual(["7"]);
});

test("it checks a place at start only when it is given the client that can ask", () => {
	const { connection: wired } = connection();
	const bare = discordPlaceProvider({
		guild: GUILD,
		connection: wired,
		logger: silentLogger(),
	});
	expect(bare.check).toBeUndefined();
	const checked = discordPlaceProvider({
		guild: GUILD,
		connection: wired,
		logger: silentLogger(),
		// SAFETY: only its presence is read.
		client: {} as Client,
	});
	expect(typeof checked.check).toBe("function");
});
