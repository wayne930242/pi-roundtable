import { expect, test } from "bun:test";
import { channelOwner, discordIdOf, discordKey } from "./team-keys.ts";

const store = {
	agentByChannel: (id: string) =>
		id === "1234567890" ? ({} as never) : undefined,
	groupByChannel: (id: string) => (id === "555" ? ({} as never) : undefined),
};

test("an agent or a group owns the Discord key of its channel", () => {
	expect(channelOwner(store, discordKey("1234567890"))).toBe("agent");
	expect(channelOwner(store, discordKey("555"))).toBe("group");
	expect(channelOwner(store, discordKey("777"))).toBeUndefined();
});

test("a key of another surface whose id equals an agent's channel id is not the agent's", () => {
	expect(channelOwner(store, "mcp:1234567890")).toBeUndefined();
	expect(channelOwner(store, "fake:1234567890")).toBeUndefined();
	expect(channelOwner(store, "webhook:555")).toBeUndefined();
	// The old slice took "?" and "1234567890" from a key of the same length as `discord:`.
	expect(channelOwner(store, "matrix:x1234567890")).toBeUndefined();
});

test("discordIdOf reads only Discord keys", () => {
	expect(discordIdOf(discordKey("42"))).toBe("42");
	expect(discordIdOf("mcp:42")).toBeUndefined();
});
