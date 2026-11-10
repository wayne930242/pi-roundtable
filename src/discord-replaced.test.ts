import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeDb } from "./core/testing/database.ts";
import { FakeChannels } from "./core/testing/fake-agent-channels.ts";
import {
	CAPTURE_DISCORD,
	captureDiscordPrompts,
	normalize,
} from "./core/testing/prompt-capture.ts";
import {
	hasWebAccess,
	type TestHost,
	testHost,
} from "./core/testing/test-host.ts";
import {
	captureToolSet,
	servedConversations,
} from "./core/testing/tool-set.ts";
import {
	DISCORD,
	type DiscordServices,
	discordAgentGuild,
} from "./discord/index.ts";
import { AGENTS, type RoundtablePlugin } from "./index.ts";
import type { AgentOps } from "./kit/index.ts";
import { partial } from "./testing.ts";

// A host whose app replaces `DISCORD` with a Discord of its own, written against the public
// entries alone. The built-in Discord plugin is dropped whole then, so what it gives the agent
// team with `discord.guild` has to come from the replacement:
// the place provider, `channel_arrange` and `channel_read`, the `#dashboard` message, the
// coordinator's place and the names in `agent_list`. The recorded tool set and prompt text are the
// built-in host's, so the replaced host is held to the same files.
const GUILD = "955555500000000001";
const ENTRY = "955555500000000002";

interface OwnDiscord {
	guild: string;
	entryChannel: string;
	channels: FakeChannels;
	channelContext?: DiscordServices["channelContext"];
	/** What the `#dashboard` message was last given. */
	shown?: string[][];
}

function ownDiscord(given: OwnDiscord): RoundtablePlugin {
	const channelContext = given.channelContext ?? (async () => undefined);
	return {
		name: "own-discord",
		provides: [DISCORD],
		replaces: [DISCORD],
		setup: (context) => {
			const connection = partial<DiscordServices["connection"]>({
				ownerChannel: async () => "discord:owner-dm",
				agentChannels: () => given.channels,
				agentDashboard: () => ({
					show: async (sections) => {
						given.shown?.push(sections);
					},
				}),
				onChannelDeleted: () => undefined,
				ownerOperations: () => partial({}),
			});
			context.services.provide(
				DISCORD,
				partial<DiscordServices>({
					connection,
					commands: { add: () => undefined },
					guard: partial<DiscordServices["guard"]>({}),
					threads: partial<DiscordServices["threads"]>({
						open: async () => undefined,
						sweep: async () => undefined,
					}),
					channelContext,
				}),
			);
			return {
				surfaces: [
					{
						surface: "discord",
						start: async () => undefined,
						sendReply: async () => undefined,
						channelContext,
					},
				],
				directChannels: [
					{
						name: "own-discord",
						label: "a direct message on Discord",
						knows: async () => true,
						reaches: async () => "discord:owner-dm" as const,
						deliver: async () => undefined,
					},
				],
				// Discord's side of the agent guild, as the docs tell a replacement to contribute it.
				...discordAgentGuild(context, {
					guild: given.guild,
					connection,
					entryChannel: given.entryChannel,
				}),
			};
		},
	};
}

const recorded = (file: string) =>
	JSON.parse(readFileSync(join(import.meta.dir, file), "utf8"));

/** The test host's configuration with Discord, which `discord: false` leaves out with the stand-in. */
const withGuild = {
	discord: { token: "token", guild: GUILD, entryChannel: ENTRY },
	http: {
		publicUrl: "https://bot.example.com",
		socketPath: join(tmpdir(), `roundtable-own-discord-${process.pid}.sock`),
	},
	// The coordinator is the agent in the entry channel, here the second seed.
	agents: [
		{
			name: "librarian",
			displayName: "Librarian",
			prompt: "You keep the reading list.",
		},
		{
			name: "archivist",
			displayName: "Archivist",
			prompt: "You file the notes.",
			channelId: ENTRY,
		},
	],
};

let host: TestHost | undefined;
afterEach(async () => {
	await host?.stop();
	host = undefined;
});

/** Waits for what the team makes in the background after the host is up. */
async function eventually(what: () => boolean | Promise<boolean>) {
	for (let tries = 0; tries < 400; tries++) {
		if (await what()) return;
		await Bun.sleep(25);
	}
	throw new Error("it never happened");
}

// Runs against a real PostgreSQL, only when ROUNDTABLE_TEST_DATABASE_URL is set and the delegation worker can load.
(hasWebAccess() ? describeDb : describeDb.skip)(
	"a host whose plugin replaces DISCORD",
	() => {
		test("its sessions offer the built-in host's tools, and its team has the entry channel's coordinator, the names in agent_list, the dashboard, and the deprecated AgentOps calls", async () => {
			const channels = new FakeChannels();
			const shown: string[][] = [];
			host = await testHost({
				discord: false,
				config: withGuild,
				plugins: [
					ownDiscord({ guild: GUILD, entryChannel: ENTRY, channels, shown }),
					servedConversations("discord:owner-dm"),
				],
			});
			const expected = recorded("core/tool-set.snapshot.json");
			const actual = await captureToolSet(host);
			// The owner's session of a host booted with `discord: false` is a test surface's, so only the agents' sessions and the tiers are the built-in host's.
			expect(actual.sessions.agent).toEqual(expected.sessions.agent);
			expect(actual.sessions["group seat"]).toEqual(
				expected.sessions["group seat"],
			);
			expect(actual.tiers).toEqual(expected.tiers);
			expect(actual.sessions.owner?.tools).not.toContain("channel_arrange");

			const { team, directory } = host.context.services.get(AGENTS);
			await eventually(
				() => directory.agent("librarian")?.channelId !== undefined,
			);
			expect(host.context.places.of("discord")?.coordinatorPlace).toBe(ENTRY);
			expect(team.coordinator()).toBe("archivist");
			// SAFETY: the agent server's team is what implements the kit's `AgentOps`.
			const ops = team as unknown as AgentOps;
			// The channel the team made is listed by its agent's name, where the bare provider wrote a mention.
			expect(await ops.list()).toEndWith(
				"Categories, in server order:\n- Agents: librarian",
			);
			await eventually(() => shown.length > 0);
			expect(shown.at(-1)?.join("\n")).toContain("Librarian");
			expect(await ops.read(`<#${ENTRY}>`, undefined, 5)).toBe(
				`<#${ENTRY}> has no messages there.`,
			);
			expect(channels.reads).toEqual([{ channelId: ENTRY, limit: 5 }]);
		});

		test("the model reads the built-in host's prompt and tool definitions", async () => {
			const { out, dirs } = await captureDiscordPrompts("owner", (given) =>
				ownDiscord({ ...CAPTURE_DISCORD, ...given }),
			);
			const expected = recorded("prompt-text.snapshot.json");
			const actual = normalize(out, dirs, [tmpdir()]);
			expect(Object.keys(actual).sort()).toEqual([
				"a agent session",
				"b group seat",
				"c owner persona conversation",
				"d member persona conversation",
				"e owner turn without a speaker",
				"h agent session with channel context",
			]);
			for (const [scenario, prompt] of Object.entries(actual))
				expect({ [scenario]: prompt }).toEqual({
					[scenario]: expected[scenario],
				});
		}, 60_000);
	},
);
