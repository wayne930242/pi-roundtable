import { expect, test } from "bun:test";
import type { AgentChannels } from "../agents/agent-ports.ts";
import { silentLogger } from "../kernel/log.ts";
import { discordPlaces } from "./agent-places.ts";
import { fakeDiscordClient } from "./place-fake-client.ts";

const GUILD = "900000000000000001";
const LISTED = "900000000000000010";
const LEFT = "900000000000000020";

/** Discord's provider over a server that answers Missing Access (50001) for every id in `denied`. */
function provider(denied: string[]) {
	const client = fakeDiscordClient({
		guild: GUILD,
		gone: () => false,
		foreign: () => false,
		denied: (id) => denied.includes(id),
		listed: () => [LISTED],
	});
	// SAFETY: `check` asks the client, not the channels.
	const channels = {} as AgentChannels;
	return discordPlaces({
		client,
		guild: GUILD,
		channels,
		onRemoved: () => undefined,
		logger: silentLogger(),
	});
}

test("Missing Access for a channel the agent guild does not list is a channel of a server the bot left", async () => {
	expect(await provider([LEFT]).check?.(LEFT)).toBe("foreign");
});

test("Missing Access for a channel the agent guild lists is no answer, and throws", async () => {
	await expect(provider([LISTED]).check?.(LISTED)).rejects.toThrow();
});
